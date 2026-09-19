import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { buildShieldsReport, fetchShieldsReport, isOwnHost, type ZoneShields } from "../src/lib/shields";
import { ctx } from "./helpers/execution-context";

/**
 * Cover for Shields: Page Shield (verified live shapes) and API Shield (documented-but-unverified
 * shapes — every /api_gateway/* read fails with "Authentication error" on the real account this
 * was built against).
 *
 * Rule under test throughout: a read that failed is "not checked" with its reason, never folded
 * into a zero. A 401/403 or Cloudflare code 10000 means missing permission; a 404 means the
 * feature is not on this plan; anything else keeps Cloudflare's own message.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token" };

const ZONE = { id: "z1", name: "example.com" };
const NOW = new Date("2026-09-19T00:00:00Z");

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function zoneWith(over: Partial<ZoneShields> = {}): ZoneShields {
	return {
		zoneId: ZONE.id,
		zoneName: ZONE.name,
		pageShield: {
			status: { available: true, enabled: true, updatedAt: null, useCloudflareReportingEndpoint: true, useConnectionUrlPath: false },
			scripts: { available: true, items: [], truncated: false, totalSeen: 0 },
			connections: { available: true, items: [], truncated: false, totalSeen: 0 },
			policies: { available: true, items: [] },
		},
		apiShield: {
			operations: { available: false, reason: "Needs \"API Gateway Read\"", savedCount: 0 },
			discovery: { available: false, reason: "Needs \"API Gateway Read\"", discoveredNotSavedCount: 0 },
			schemaValidation: { available: false, reason: "Needs \"API Gateway Read\"", defaultAction: null, perOperationOverrideCount: null },
			userSchemas: { available: false, reason: "Needs \"API Gateway Read\"", count: 0 },
			configuration: { available: false, reason: "Needs \"API Gateway Read\"", sessionIdentifierConfigured: false, sessionIdentifierCount: 0 },
			fullyChecked: false,
		},
		...over,
	};
}

// ---------------------------------------------------------------------------
// isOwnHost

describe("isOwnHost", () => {
	it("treats the zone's own apex as its own host", () => {
		expect(isOwnHost("example.com", "example.com")).toBe(true);
	});
	it("treats a subdomain of the zone as its own host", () => {
		expect(isOwnHost("assets.example.com", "example.com")).toBe(true);
	});
	it("treats an unrelated domain as third-party", () => {
		expect(isOwnHost("evil-cdn.example.net", "example.com")).toBe(false);
	});
	it("does not let a suffix match fool it (not-example.com vs example.com)", () => {
		expect(isOwnHost("not-example.com", "example.com")).toBe(false);
	});
	it("is case- and trailing-dot-insensitive", () => {
		expect(isOwnHost("Assets.Example.com.", "example.com")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildShieldsReport — findings

describe("Page Shield findings", () => {
	it("flags a disabled zone", () => {
		const zone = zoneWith({ pageShield: { ...zoneWith().pageShield, status: { available: true, enabled: false, updatedAt: null, useCloudflareReportingEndpoint: false, useConnectionUrlPath: false } } });
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "low", title: "Page Shield disabled" }));
	});

	it("does not flag an unchecked status as disabled", () => {
		const zone = zoneWith({ pageShield: { ...zoneWith().pageShield, status: { available: false, reason: "missing scope", enabled: false, updatedAt: null, useCloudflareReportingEndpoint: false, useConnectionUrlPath: false } } });
		const result = buildShieldsReport([zone], []);
		expect(result.findings.some((f) => f.title === "Page Shield disabled")).toBe(false);
	});

	it("flags a script reported malicious as high", () => {
		const base = zoneWith();
		const zone = zoneWith({
			pageShield: {
				...base.pageShield,
				scripts: {
					available: true,
					totalSeen: 1,
					truncated: false,
					items: [
						{
							id: "s1", url: "https://evil.example.net/x.js", host: "evil.example.net", addedAt: null,
							firstSeenAt: daysAgo(30), lastSeenAt: null, firstPageUrl: null, pageUrls: [], status: "active",
							domainReportedMalicious: true, maliciousDomainCategories: ["malware"], urlReportedMalicious: null,
							maliciousUrlCategories: null, urlContainsCdnCgiPath: false, versionsCount: 1, thirdParty: true, newThirdParty: false,
						},
					],
				},
			},
		});
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "high", title: "Malicious script or connection flagged" }));
		expect(result.totals.maliciousFlags).toBe(1);
	});

	it("flags a third-party script first seen within 7 days as info, not a script older than that", () => {
		const base = zoneWith();
		const newItem = {
			id: "s1", url: "https://cdn.example.net/x.js", host: "cdn.example.net", addedAt: null,
			firstSeenAt: daysAgo(2), lastSeenAt: null, firstPageUrl: null, pageUrls: [], status: "active",
			domainReportedMalicious: false, maliciousDomainCategories: null, urlReportedMalicious: null,
			maliciousUrlCategories: null, urlContainsCdnCgiPath: false, versionsCount: 1, thirdParty: true, newThirdParty: true,
		};
		const oldItem = { ...newItem, id: "s2", firstSeenAt: daysAgo(60), newThirdParty: false };
		const zone = zoneWith({ pageShield: { ...base.pageShield, scripts: { available: true, totalSeen: 2, truncated: false, items: [newItem, oldItem] } } });
		const result = buildShieldsReport([zone], []);
		const infoFindings = result.findings.filter((f) => f.title === "New third-party script");
		expect(infoFindings).toHaveLength(1);
		expect(infoFindings[0].severity).toBe("info");
	});

	it("flags zero policies while scripts are present as low", () => {
		const base = zoneWith();
		const zone = zoneWith({
			pageShield: {
				...base.pageShield,
				scripts: {
					available: true, totalSeen: 1, truncated: false,
					items: [{ id: "s1", url: "https://example.com/a.js", host: "example.com", addedAt: null, firstSeenAt: daysAgo(90), lastSeenAt: null, firstPageUrl: null, pageUrls: [], status: "active", domainReportedMalicious: false, maliciousDomainCategories: null, urlReportedMalicious: null, maliciousUrlCategories: null, urlContainsCdnCgiPath: false, versionsCount: 1, thirdParty: false, newThirdParty: false }],
				},
				policies: { available: true, items: [] },
			},
		});
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "low", title: "No Page Shield policies" }));
	});

	it("does not flag zero policies when there are also zero scripts", () => {
		const result = buildShieldsReport([zoneWith()], []);
		expect(result.findings.some((f) => f.title === "No Page Shield policies")).toBe(false);
	});
});

describe("API Shield findings — only from readable data", () => {
	it("raises nothing when every API Shield read is unavailable", () => {
		const result = buildShieldsReport([zoneWith()], []);
		expect(result.findings.filter((f) => f.source === "api-shield")).toHaveLength(0);
		expect(result.totals.apiShieldCheckedZones).toBe(0);
		expect(result.totals.apiShieldNotCheckedZones).toBe(1);
	});

	it("flags discovered-but-unsaved endpoints as low", () => {
		const base = zoneWith();
		const zone = zoneWith({ apiShield: { ...base.apiShield, discovery: { available: true, discoveredNotSavedCount: 3 } } });
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "low", title: "Discovered endpoints not saved" }));
	});

	it("flags schema validation absent or log-only while schemas exist as medium", () => {
		const base = zoneWith();
		const zone = zoneWith({
			apiShield: {
				...base.apiShield,
				schemaValidation: { available: true, defaultAction: "log", perOperationOverrideCount: null },
				userSchemas: { available: true, count: 2 },
			},
		});
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "medium", title: "Schema validation not blocking" }));
	});

	it("does not flag schema validation when it is set to block", () => {
		const base = zoneWith();
		const zone = zoneWith({
			apiShield: {
				...base.apiShield,
				schemaValidation: { available: true, defaultAction: "block", perOperationOverrideCount: null },
				userSchemas: { available: true, count: 2 },
			},
		});
		const result = buildShieldsReport([zone], []);
		expect(result.findings.some((f) => f.title === "Schema validation not blocking")).toBe(false);
	});

	it("does not flag schema validation when there are no uploaded schemas", () => {
		const base = zoneWith();
		const zone = zoneWith({
			apiShield: {
				...base.apiShield,
				schemaValidation: { available: true, defaultAction: "none", perOperationOverrideCount: null },
				userSchemas: { available: true, count: 0 },
			},
		});
		const result = buildShieldsReport([zone], []);
		expect(result.findings.some((f) => f.title === "Schema validation not blocking")).toBe(false);
	});

	it("flags no session identifier as info, only when configuration is readable", () => {
		const base = zoneWith();
		const zone = zoneWith({ apiShield: { ...base.apiShield, configuration: { available: true, sessionIdentifierConfigured: false, sessionIdentifierCount: 0 } } });
		const result = buildShieldsReport([zone], []);
		expect(result.findings).toContainEqual(expect.objectContaining({ severity: "info", title: "No session identifier configured" }));
	});

	it("marks a zone fully checked only when all five API Shield reads succeed", () => {
		const base = zoneWith();
		const zone = zoneWith({
			apiShield: {
				operations: { available: true, savedCount: 1 },
				discovery: { available: true, discoveredNotSavedCount: 0 },
				schemaValidation: { available: true, defaultAction: "block", perOperationOverrideCount: null },
				userSchemas: { available: true, count: 0 },
				configuration: { available: true, sessionIdentifierConfigured: true, sessionIdentifierCount: 1 },
				fullyChecked: true,
			},
		});
		void base;
		const result = buildShieldsReport([zone], []);
		expect(result.totals.apiShieldCheckedZones).toBe(1);
		expect(result.totals.apiShieldNotCheckedZones).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// fetchShieldsReport — degradation per reader

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function list<T>(result: T[]): { success: true; result: T[]; result_info: { total_pages: number } } {
	return { success: true, result, result_info: { total_pages: 1 } };
}

describe("fetchShieldsReport degradation", () => {
	afterEach(() => vi.restoreAllMocks());

	it("reports Page Shield status as missing permission on a 403", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/page_shield")) return json({ success: false, errors: [{ message: "Authentication error", code: 10000 }] }, 403);
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		expect(result.zones[0].pageShield.status.available).toBe(false);
		expect(result.zones[0].pageShield.status.reason).toMatch(/Client-side Security: Read/);
	});

	it("reports a 404 on page_shield as not available on this plan, distinct from a permission error", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/page_shield")) return json({ success: false, errors: [{ message: "not found" }] }, 404);
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		expect(result.zones[0].pageShield.status.reason).toMatch(/not available on this plan/i);
	});

	it("caps scripts at 500 and sets the truncation flag, while totalSeen keeps the real count", async () => {
		const many = Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, url: `https://example.com/${i}.js`, host: "example.com" }));
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/page_shield/scripts")) return json(list(many));
			if (url.endsWith("/page_shield")) return json({ success: true, result: { enabled: true } });
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		expect(result.zones[0].pageShield.scripts.items).toHaveLength(500);
		expect(result.zones[0].pageShield.scripts.truncated).toBe(true);
		expect(result.zones[0].pageShield.scripts.totalSeen).toBe(600);
	});

	it("identifies a script's own domain as not third-party", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/page_shield/scripts")) return json(list([{ id: "s1", url: "https://www.example.com/a.js", host: "www.example.com", first_seen_at: daysAgo(1) }]));
			if (url.endsWith("/page_shield")) return json({ success: true, result: { enabled: true } });
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		const item = result.zones[0].pageShield.scripts.items[0];
		expect(item.thirdParty).toBe(false);
		expect(item.newThirdParty).toBe(false);
	});

	it("reports every API Shield read as missing permission on a 10000 auth error", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/api_gateway/")) {
				return json({ success: false, errors: [{ message: "Authentication error", code: 10000 }] }, 403);
			}
			if (url.endsWith("/page_shield")) return json({ success: true, result: { enabled: true } });
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		const api = result.zones[0].apiShield;
		expect(api.operations.available).toBe(false);
		expect(api.discovery.available).toBe(false);
		expect(api.schemaValidation.available).toBe(false);
		expect(api.userSchemas.available).toBe(false);
		expect(api.configuration.available).toBe(false);
		expect(api.fullyChecked).toBe(false);
		for (const r of [api.operations, api.discovery, api.schemaValidation, api.userSchemas, api.configuration]) {
			expect(r.reason).toMatch(/API Gateway: Read/);
		}
	});

	it("reads saved operations, discovery state, schema validation, user schemas and session identifier when permitted", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/api_gateway/operations")) return json(list([{ operation_id: "o1" }, { operation_id: "o2" }]));
			if (url.includes("/api_gateway/discovery/operations")) return json(list([{ id: "d1", state: "review" }, { id: "d2", state: "saved" }]));
			if (url.includes("/api_gateway/settings/schema_validation")) return json({ success: true, result: { validation_default_mitigation_action: "block" } });
			if (url.includes("/api_gateway/user_schemas")) return json(list([{ schema_id: "sc1" }]));
			if (url.includes("/api_gateway/configuration")) return json({ success: true, result: { auth_id_characteristics: [{ name: "sess", type: "cookie" }] } });
			if (url.endsWith("/page_shield")) return json({ success: true, result: { enabled: true } });
			return json(list([]));
		}) as typeof fetch;
		const result = await fetchShieldsReport([ZONE], "tok", NOW);
		const api = result.zones[0].apiShield;
		expect(api.operations).toEqual({ available: true, savedCount: 2 });
		expect(api.discovery).toEqual({ available: true, discoveredNotSavedCount: 1 });
		expect(api.schemaValidation).toEqual({ available: true, defaultAction: "block", perOperationOverrideCount: null });
		expect(api.userSchemas).toEqual({ available: true, count: 1 });
		expect(api.configuration).toEqual({ available: true, sessionIdentifierConfigured: true, sessionIdentifierCount: 1 });
		expect(api.fullyChecked).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Route

function mockCloudflare(opts: { pageShieldError?: { status: number; code?: number; message: string } } = {}) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/zones?account.id=")) return json(list([{ id: ZONE.id, name: ZONE.name }]));
		if (url.endsWith("/page_shield")) {
			if (opts.pageShieldError) return json({ success: false, errors: [{ message: opts.pageShieldError.message, code: opts.pageShieldError.code }] }, opts.pageShieldError.status);
			return json({ success: true, result: { enabled: true } });
		}
		return json(list([]));
	}) as typeof fetch;
}

beforeEach(() => mockCloudflare());
afterEach(() => vi.restoreAllMocks());

describe("GET /api/shields/report", () => {
	it("returns zones and totals for an account", async () => {
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { zones: { zoneId: string }[]; totals: { zones: number } } };
		expect(body.result.zones).toHaveLength(1);
		expect(body.result.totals.zones).toBe(1);
	});

	it("narrows to one zone with zone_id", async () => {
		const hexZoneId = "cccccccccccccccccccccccccccccccc".slice(0, 32);
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/zones?account.id=")) return json(list([{ id: hexZoneId, name: ZONE.name }, { id: "dddddddddddddddddddddddddddddddd", name: "other.example" }]));
			if (url.endsWith("/page_shield")) return json({ success: true, result: { enabled: true } });
			return json(list([]));
		}) as typeof fetch;
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}&zone_id=${hexZoneId}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { zones: { zoneId: string }[] } };
		expect(body.result.zones).toHaveLength(1);
		expect(body.result.zones[0].zoneId).toBe(hexZoneId);
	});

	it("rejects an invalid account_id without calling upstream", async () => {
		const res = await app.request("/api/shields/report?account_id=not-hex", { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects an invalid zone_id without calling upstream", async () => {
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}&zone_id=not-hex`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}`, {}, ENV, ctx());
		expect(res.status).toBe(401);
	});

	it("maps an upstream zones failure to its own status", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "nope" }] }, 403)) as typeof fetch;
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(403);
	});

	it("still returns 200 with a per-zone reason when Page Shield itself is refused", async () => {
		mockCloudflare({ pageShieldError: { status: 403, code: 10000, message: "Authentication error" } });
		const res = await app.request(`/api/shields/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { zones: { pageShield: { status: { available: boolean; reason?: string } } }[] } };
		expect(body.result.zones[0].pageShield.status.available).toBe(false);
		expect(body.result.zones[0].pageShield.status.reason).toMatch(/Client-side Security: Read/);
	});
});

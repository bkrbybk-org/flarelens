import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { tokenFingerprint } from "../src/lib/ai-sec";

/**
 * Integration cover for POST /api/ai-security/analyze: the Hono route, the ported ai-sec
 * library, the Cloudflare client and the Cache API layer wired together, with only the network
 * mocked. Complements the unit tests (pure domain logic) and the system tests (all routes).
 */

const ACCOUNT = "11111111111111111111111111111111";
const ZONE_A = "44444444444444444444444444444444";
const ZONE_B = "33333333333333333333333333333333";

const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };

/** Hono needs an executionCtx because the ai-sec layer writes its caches through waitUntil. */
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });

interface CacheRecord {
	keys: string[];
}

let cacheRecord: CacheRecord;
let graphqlCalls: { query: string; auth: string }[];

/**
 * `caches` is a Workers global with no Node equivalent, so the suite supplies one. Kept as a
 * real (if non-persisting) implementation rather than a no-op so cache *keys* can be asserted —
 * that is where tenant isolation lives.
 */
function installCaches() {
	cacheRecord = { keys: [] };
	(globalThis as { caches?: unknown }).caches = {
		default: {
			match: async (key: Request | string) => {
				cacheRecord.keys.push(typeof key === "string" ? key : key.url);
				return undefined;
			},
			put: async () => {},
		},
	};
}

function installFetch(options: { zonesStatus?: number; graphqlStatus?: number; zones?: { id: string; name: string }[] } = {}) {
	const zones = options.zones ?? [
		{ id: ZONE_A, name: "example.com" },
		{ id: ZONE_B, name: "example.org" },
	];
	graphqlCalls = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers = new Headers(init?.headers);

		if (url.includes("/graphql")) {
			graphqlCalls.push({ query: String(JSON.parse(String(init?.body ?? "{}")).query ?? ""), auth: headers.get("Authorization") || "" });
			if (options.graphqlStatus && options.graphqlStatus !== 200) {
				return new Response("upstream said no", { status: options.graphqlStatus });
			}
			// An empty data object: every optional field probes as unavailable, which is the
			// hardest shape for the aggregation to handle and the one a low-scope token produces.
			return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } });
		}

		if (options.zonesStatus && options.zonesStatus !== 200) {
			return new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), {
				status: options.zonesStatus,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ success: true, result: zones, result_info: { total_pages: 1 } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function analyze(body: Record<string, unknown>, token = "caller-token") {
	return app.request(
		"/api/ai-security/analyze",
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		ENV,
		ctx(),
	);
}

beforeEach(() => {
	installCaches();
	installFetch();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /api/ai-security/analyze", () => {
	it("returns the whole dashboard envelope in one response", async () => {
		const res = await analyze({ accountId: ACCOUNT, range: "24h" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; result: Record<string, unknown> };
		expect(body.success).toBe(true);
		// One endpoint per screen is deliberate: splitting it would re-run the zone fan-out.
		expect(Object.keys(body.result).sort()).toEqual(["data", "schema", "window", "zones"]);
	});

	it("states which detection fields the schema resolved", async () => {
		// A KPI that is zero because the field is absent must be distinguishable from one that
		// is zero because nothing was detected; the panel reads this.
		const res = await analyze({ accountId: ACCOUNT, range: "24h" });
		const body = (await res.json()) as {
			result: { schema: { dataset: string | null; probedAt: string; rows: { id: string; resolved: boolean; detail: string }[] } };
		};
		const { schema } = body.result;
		expect(schema.rows.map((row) => row.id)).toEqual(["injection", "pii", "unsafe", "custom", "tokenCount", "ja4", "payloads"]);
		// Every unresolved row has to say what it costs, or the panel is just a red dot.
		for (const row of schema.rows) {
			if (!row.resolved) expect(row.detail.length).toBeGreaterThan(0);
		}
		expect(typeof schema.probedAt).toBe("string");
	});

	it("reports the window it actually used, honouring the requested range", async () => {
		const res = await analyze({ accountId: ACCOUNT, range: "30m" });
		const { result } = (await res.json()) as { result: { window: { key: string; bucket: string } } };
		expect(result.window.key).toBe("30m");
		expect(result.window.bucket).toBe("datetimeFiveMinutes");
	});

	it("falls back to the default range for an unknown one rather than 400ing", async () => {
		// A stale deep link should degrade to a working page.
		const res = await analyze({ accountId: ACCOUNT, range: "does-not-exist" });
		const { result } = (await res.json()) as { result: { window: { key: string } } };
		expect(res.status).toBe(200);
		expect(result.window.key).toBe("24h");
	});

	it("lists every visible zone, even when scoped to one", async () => {
		const res = await analyze({ accountId: ACCOUNT, zoneId: ZONE_A });
		const { result } = (await res.json()) as { result: { zones: { id: string }[] } };
		// The picker needs all of them; scoping only narrows what is queried.
		expect(result.zones.map((z) => z.id).sort()).toEqual([ZONE_B, ZONE_A].sort());
	});

	it("ignores a zoneId the token cannot see instead of erroring", async () => {
		const res = await analyze({ accountId: ACCOUNT, zoneId: "ffffffffffffffffffffffffffffffff" });
		expect(res.status).toBe(200);
	});

	it("rejects a malformed accountId before doing any work", async () => {
		const res = await analyze({ accountId: "not-a-hex-id" });
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects a malformed zoneId", async () => {
		const res = await analyze({ accountId: ACCOUNT, zoneId: "nope" });
		expect(res.status).toBe(400);
	});

	it("rejects a body that is not JSON", async () => {
		const res = await app.request(
			"/api/ai-security/analyze",
			{ method: "POST", headers: { Authorization: "Bearer caller-token", "Content-Type": "application/json" }, body: "{" },
			ENV,
			ctx(),
		);
		expect(res.status).toBe(400);
	});

	it("forwards the caller's token upstream, never a bare account id", async () => {
		await analyze({ accountId: ACCOUNT }, "specific-caller-token");
		expect(graphqlCalls.length).toBeGreaterThan(0);
		for (const call of graphqlCalls) expect(call.auth).toBe("Bearer specific-caller-token");
	});

	it("sends only Worker-authored GraphQL documents", async () => {
		// The client never supplies a query, so this cannot become an open GraphQL proxy.
		await analyze({ accountId: ACCOUNT, range: "24h" });
		for (const call of graphqlCalls) expect(call.query).toMatch(/query|\{/);
	});
});

describe("upstream failures", () => {
	it("surfaces a zone-list failure as a 502 with a readable message", async () => {
		installFetch({ zonesStatus: 400 });
		const res = await analyze({ accountId: ACCOUNT });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { errors: { message: string }[] };
		expect(body.errors[0].message).toMatch(/zone list/i);
	});

	it("passes an upstream 403 through rather than flattening it to 502", async () => {
		// useAiSecurityData treats 401/403 as an expired session; a blanket 502 would strand it.
		installFetch({ zonesStatus: 403 });
		const res = await analyze({ accountId: ACCOUNT });
		expect(res.status).toBe(403);
	});

	it("passes an upstream 401 through", async () => {
		installFetch({ zonesStatus: 401 });
		expect((await analyze({ accountId: ACCOUNT })).status).toBe(401);
	});
});

describe("cache key isolation", () => {
	it("namespaces every cache key by a hash of the token, never the token itself", async () => {
		await analyze({ accountId: ACCOUNT }, "token-one");
		const fp = await tokenFingerprint("token-one");
		expect(cacheRecord.keys.length).toBeGreaterThan(0);
		for (const key of cacheRecord.keys) {
			expect(key).not.toContain("token-one");
		}
		expect(cacheRecord.keys.some((k) => k.includes(fp))).toBe(true);
	});

	it("gives two different tokens disjoint cache keys", async () => {
		// A Worker isolate is shared across operators; one bare key would leak tenant data.
		await analyze({ accountId: ACCOUNT }, "token-one");
		const first = [...cacheRecord.keys];
		installCaches();
		installFetch();
		await analyze({ accountId: ACCOUNT }, "token-two");
		expect(cacheRecord.keys.some((k) => first.includes(k))).toBe(false);
	});

	it("derives a short, non-reversible fingerprint", async () => {
		const fp = await tokenFingerprint("token-one");
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
		expect(await tokenFingerprint("token-one")).toBe(fp);
		expect(await tokenFingerprint("token-two")).not.toBe(fp);
	});
});

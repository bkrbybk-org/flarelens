import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
	computeFindings,
	fetchBotManagement,
	fetchRateLimitScope,
	fetchRatelimitBotReport,
	inferPlanTier,
	isBotProtectionOn,
	type BbZone,
	type BotManagementZone,
	type RateLimitScope,
} from "../src/lib/ratelimit-bot";
import { ctx } from "./helpers/execution-context";

/**
 * Cover for Rate Limits & Bots: the 404-vs-403 distinction on the http_ratelimit entrypoint
 * (a real zero vs. an unreadable scope), plan-tier inference from which bot_management keys are
 * present, unknown-key passthrough, every finding, and that no finding ever fires from a check
 * that could not run.
 */

const TOKEN = "test-token";
const ACCOUNT = "11111111111111111111111111111111";
const ZONE: BbZone = { id: "z1", name: "example.com" };
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token" };

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// fetchRateLimitScope: 404 vs 403

describe("fetchRateLimitScope", () => {
	it("treats a 404 entrypoint as a real, checked zero", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "not found" }] }, 404)) as typeof fetch;
		const scope = await fetchRateLimitScope("zones", ZONE.id, ZONE.name, TOKEN);
		expect(scope.status).toBe("ok");
		expect(scope.rules).toEqual([]);
	});

	it("treats a 403 entrypoint as unknown, never as zero", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "missing scope" }] }, 403)) as typeof fetch;
		const scope = await fetchRateLimitScope("zones", ZONE.id, ZONE.name, TOKEN);
		expect(scope.status).toBe("unknown");
		expect(scope.reason).toMatch(/missing permission/i);
		expect(scope.rules).toEqual([]);
	});

	it("extracts rule fields including ratelimit params, using snake_case→camelCase mapping", async () => {
		globalThis.fetch = vi.fn(async () =>
			json({
				success: true,
				result: {
					rules: [
						{
							id: "r1",
							description: "Login throttle",
							enabled: true,
							action: "block",
							expression: 'http.request.uri.path eq "/login"',
							ratelimit: {
								characteristics: ["ip.src"],
								period: 60,
								requests_per_period: 100,
								mitigation_timeout: 600,
								counting_expression: "true",
								requests_to_origin: true,
								score_per_period: 5,
								score_response_header_name: "X-Score",
							},
						},
					],
				},
			}),
		) as typeof fetch;
		const scope = await fetchRateLimitScope("zones", ZONE.id, ZONE.name, TOKEN);
		expect(scope.status).toBe("ok");
		expect(scope.rules).toEqual([
			{
				ruleId: "r1",
				description: "Login throttle",
				enabled: true,
				action: "block",
				expression: 'http.request.uri.path eq "/login"',
				ratelimit: {
					characteristics: ["ip.src"],
					period: 60,
					requestsPerPeriod: 100,
					mitigationTimeout: 600,
					countingExpression: "true",
					requestsToOrigin: true,
					scorePerPeriod: 5,
					scoreResponseHeaderName: "X-Score",
				},
			},
		]);
	});

	it("treats a disabled-by-omission rule as enabled, mirroring waf-meta's convention", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: true, result: { rules: [{ id: "r1" }] } })) as typeof fetch;
		const scope = await fetchRateLimitScope("zones", ZONE.id, ZONE.name, TOKEN);
		expect(scope.rules[0].enabled).toBe(true);
	});

	it("reports account scope without a zoneId/zoneName", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: true, result: { rules: [] } })) as typeof fetch;
		const scope = await fetchRateLimitScope("accounts", ACCOUNT, undefined, TOKEN);
		expect(scope.scope).toBe("account");
		expect(scope.zoneId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Bot management: plan tier inference + passthrough

describe("inferPlanTier", () => {
	it("infers Bot Fight Mode from fight_mode alone", () => {
		expect(inferPlanTier({ fight_mode: false })).toBe("bot_fight_mode");
	});

	it("infers Super Bot Fight Mode from any sbfm_* key", () => {
		expect(inferPlanTier({ fight_mode: false, sbfm_likely_automated: "block" })).toBe("super_bot_fight_mode");
	});

	it("infers Enterprise Bot Management from enterprise-only keys, even alongside sbfm_* keys", () => {
		expect(inferPlanTier({ sbfm_verified_bots: "allow", using_latest_model: true })).toBe("enterprise");
	});

	it("reports unknown when none of the recognised keys are present", () => {
		expect(inferPlanTier({ some_future_field: true })).toBe("unknown");
	});
});

describe("fetchBotManagement", () => {
	it("passes unknown keys through untouched", async () => {
		globalThis.fetch = vi.fn(async () =>
			json({ success: true, result: { fight_mode: true, some_future_field: "x" } }),
		) as typeof fetch;
		const zone = await fetchBotManagement(ZONE.id, ZONE.name, TOKEN);
		expect(zone.status).toBe("ok");
		expect(zone.settings.some_future_field).toBe("x");
		expect(zone.planTier).toBe("bot_fight_mode");
	});

	it("reports 403 as unknown with a reason, not as protection off", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "no scope" }] }, 403)) as typeof fetch;
		const zone = await fetchBotManagement(ZONE.id, ZONE.name, TOKEN);
		expect(zone.status).toBe("unknown");
		expect(zone.reason).toMatch(/missing permission/i);
		expect(zone.planTier).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// Findings

describe("computeFindings", () => {
	const okZoneScope = (over: Partial<RateLimitScope> = {}): RateLimitScope => ({
		scope: "zone",
		zoneId: "z1",
		zoneName: "example.com",
		status: "ok",
		rules: [],
		...over,
	});
	const okBotZone = (settings: Record<string, unknown>, over: Partial<BotManagementZone> = {}): BotManagementZone => ({
		zoneId: "z1",
		zoneName: "example.com",
		status: "ok",
		planTier: inferPlanTier(settings),
		settings,
		...over,
	});

	it("flags a zone with no rate-limit rules", () => {
		const findings = computeFindings([okZoneScope()], []);
		expect(findings).toContainEqual(expect.objectContaining({ title: "No rate-limit rules configured", severity: "medium" }));
	});

	it("does not flag the account scope for having no rules — only zones are graded that way", () => {
		const findings = computeFindings([{ scope: "account", status: "ok", rules: [] }], []);
		expect(findings.find((f) => f.title === "No rate-limit rules configured")).toBeUndefined();
	});

	it("flags a disabled rate-limit rule", () => {
		const scope = okZoneScope({
			rules: [{ ruleId: "r1", description: "Old rule", enabled: false, action: "block", expression: "true", ratelimit: null }],
		});
		const findings = computeFindings([scope], []);
		expect(findings).toContainEqual(expect.objectContaining({ title: "Rate-limit rule disabled" }));
	});

	it("flags a rate-limit rule whose action is only log", () => {
		const scope = okZoneScope({
			rules: [{ ruleId: "r1", description: "Watch only", enabled: true, action: "log", expression: "true", ratelimit: null }],
		});
		const findings = computeFindings([scope], []);
		expect(findings).toContainEqual(expect.objectContaining({ title: "Rate-limit rule only logs" }));
	});

	it("does not double-flag an enabled, blocking rule", () => {
		const scope = okZoneScope({
			rules: [{ ruleId: "r1", description: "Good rule", enabled: true, action: "block", expression: "true", ratelimit: null }],
		});
		const findings = computeFindings([scope], []);
		expect(findings.filter((f) => f.title.startsWith("Rate-limit rule"))).toEqual([]);
	});

	it("flags bot protection entirely off: fight_mode false and no sbfm action set", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: false, sbfm_likely_automated: "off" })]);
		expect(findings).toContainEqual(expect.objectContaining({ title: "Bot protection is off", severity: "high" }));
	});

	it("does not flag bot protection off when fight_mode is on", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: true })]);
		expect(findings.find((f) => f.title === "Bot protection is off")).toBeUndefined();
	});

	it("does not flag bot protection off when an sbfm action is set beyond off", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: false, sbfm_definitely_automated: "block" })]);
		expect(findings.find((f) => f.title === "Bot protection is off")).toBeUndefined();
	});

	it("treats SBFM with every mitigating group set to allow as off — Cloudflare's documented way to disable it", () => {
		const settings = { fight_mode: false, sbfm_definitely_automated: "allow", sbfm_likely_automated: "allow", sbfm_verified_bots: "allow" };
		expect(isBotProtectionOn(settings)).toBe(false);
		expect(computeFindings([], [okBotZone(settings)])).toContainEqual(expect.objectContaining({ title: "Bot protection is off" }));
	});

	it("does not count verified bots alone as protection", () => {
		expect(isBotProtectionOn({ fight_mode: false, sbfm_verified_bots: "block" })).toBe(false);
	});

	it("counts an Enterprise Bot Management zone as protected without fight_mode", () => {
		const settings = { using_latest_model: true, enable_js: true };
		expect(isBotProtectionOn(settings)).toBe(true);
		expect(computeFindings([], [okBotZone(settings)]).find((f) => f.title === "Bot protection is off")).toBeUndefined();
	});

	it("does not read ai_bots_protection as an Enterprise signal — it exists on every plan", () => {
		expect(inferPlanTier({ fight_mode: true, ai_bots_protection: "block" })).toBe("bot_fight_mode");
	});

	it("flags enable_js disabled", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: true, enable_js: false })]);
		expect(findings).toContainEqual(expect.objectContaining({ title: "JS detection disabled" }));
	});

	it("flags AI bots not blocked", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: true, ai_bots_protection: "allow" })]);
		expect(findings).toContainEqual(expect.objectContaining({ title: "AI bots not blocked", severity: "info" }));
	});

	it("does not flag AI bots when protection is block", () => {
		const findings = computeFindings([], [okBotZone({ fight_mode: true, ai_bots_protection: "block" })]);
		expect(findings.find((f) => f.title === "AI bots not blocked")).toBeUndefined();
	});

	it("never emits a finding from a scope or zone whose check came back unknown", () => {
		const unknownRateLimit: RateLimitScope = { scope: "zone", zoneId: "z1", zoneName: "example.com", status: "unknown", reason: "nope", rules: [] };
		const unknownBot: BotManagementZone = { zoneId: "z1", zoneName: "example.com", status: "unknown", reason: "nope", planTier: "unknown", settings: {} };
		const findings = computeFindings([unknownRateLimit], [unknownBot]);
		expect(findings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// fetchRatelimitBotReport: totals

describe("fetchRatelimitBotReport", () => {
	it("assembles totals across the account scope and every zone", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/bot_management")) {
				return json({ success: true, result: { fight_mode: true } });
			}
			if (url.includes("/rulesets/phases/")) {
				if (url.includes("/accounts/")) return json({ success: false, errors: [{ message: "not found" }] }, 404);
				return json({ success: true, result: { rules: [{ id: "r1", enabled: true, action: "block", ratelimit: { requests_per_period: 10, period: 60 } }] } });
			}
			return json({ success: true, result: [] });
		}) as typeof fetch;

		const result = await fetchRatelimitBotReport(ACCOUNT, [ZONE], TOKEN);
		expect(result.totals.zonesChecked).toBe(1);
		expect(result.totals.rateLimitRules).toBe(1);
		expect(result.totals.zonesWithNoRateLimitRules).toBe(0);
		expect(result.totals.botProtectionOn).toBe(1);
		expect(result.totals.botProtectionOff).toBe(0);
		expect(result.totals.botProtectionUnknown).toBe(0);
		expect(result.rateLimit).toHaveLength(2); // account + zone
	});
});

// ---------------------------------------------------------------------------
// Route: GET /api/bots/report

describe("GET /api/bots/report", () => {
	function mockCloudflare() {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/zones?account.id=")) {
				return json({ success: true, result: [{ id: ZONE.id, name: ZONE.name }], result_info: { total_pages: 1 } });
			}
			if (url.includes("/bot_management")) return json({ success: true, result: { fight_mode: true } });
			if (url.includes("/rulesets/phases/")) return json({ success: false, errors: [{ message: "not found" }] }, 404);
			return json({ success: true, result: [] });
		}) as typeof fetch;
	}

	beforeEach(() => mockCloudflare());
	afterEach(() => vi.restoreAllMocks());

	it("returns rate-limit scopes, bot management and totals for an account", async () => {
		const res = await app.request(`/api/bots/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { totals: { zonesChecked: number } } };
		expect(body.result.totals.zonesChecked).toBe(1);
	});

	it("rejects a malformed account id before any upstream call", async () => {
		const res = await app.request("/api/bots/report?account_id=not-hex", { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects a malformed zone id", async () => {
		const res = await app.request(`/api/bots/report?account_id=${ACCOUNT}&zone_id=not-hex`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/bots/report?account_id=${ACCOUNT}`, {}, ENV, ctx());
		expect(res.status).toBe(401);
	});

	it("maps an upstream zones failure to its own status", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "nope" }] }, 403)) as typeof fetch;
		const res = await app.request(`/api/bots/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(403);
	});
});

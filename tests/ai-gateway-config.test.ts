import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conditionText,
	fetchAiGatewayConfig,
	fetchAiGatewayFlags,
	fetchAiGatewayRefusals,
	flagsOf,
	groupRefusals,
	refusalOf,
	routeModels,
	routeSteps,
	trimGateway,
} from "../src/lib/ai-gateway-config";

/** AI Gateway settings, dynamic routes and refusals, read from the REST API (AI Gateway: Read). */

const ACC = "0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockRest(routes: Record<string, unknown>) {
	const calls: string[] = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		const path = new URL(url).pathname.replace(`/client/v4/accounts/${ACC}`, "");
		const body = routes[path] ?? { success: true, result: [] };
		return new Response(JSON.stringify(body), { status: (body as { status?: number }).status ?? 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return calls;
}

const GATEWAY = {
	id: "guarded",
	cache_ttl: 1800,
	rate_limiting_limit: 100,
	rate_limiting_interval: 60,
	rate_limiting_technique: "sliding",
	authentication: true,
	collect_logs: true,
	log_management: 10000,
	guardrails: { prompt: { S10: "BLOCK", S2: "BLOCK", P1: "FLAG" }, response: { S1: "FLAG" } },
	dlp: { enabled: true, policies: [{ id: "Credentials and Secrets", enabled: true, action: "BLOCK", check: ["REQUEST"], profiles: ["a", "b"] }] },
	spend_limits: { enabled: true },
};

describe("gateway settings", () => {
	it("trims a gateway to what explains its traffic, categories in their natural order", () => {
		expect(trimGateway(GATEWAY)).toEqual({
			id: "guarded",
			isDefault: false,
			cacheTtl: 1800,
			rateLimit: { limit: 100, intervalSeconds: 60, technique: "sliding" },
			authentication: true,
			collectLogs: true,
			logLimit: 10000,
			guardrails: { prompt: { block: ["S2", "S10"], flag: ["P1"] }, response: { block: [], flag: ["S1"] } },
			dlp: { policies: [{ name: "Credentials and Secrets", action: "BLOCK", check: ["REQUEST"], profiles: 2, enabled: true }] },
			spendLimits: true,
		});
		// Off is null, not an empty object, so the page can say "off".
		expect(trimGateway({ id: "plain", guardrails: null, dlp: { enabled: false, policies: [] } })).toMatchObject({ guardrails: null, dlp: null, rateLimit: null, cacheTtl: 0 });
	});

	it("writes a route's conditions out, and walks it for every model it can reach", () => {
		expect(conditionText({ $and: [{ $or: [{ "metadata.tier": { $eq: "pro" } }, { "metadata.tier": { $eq: "team" } }] }] })).toBe('metadata.tier = "pro" or metadata.tier = "team"');
		expect(conditionText({})).toBe("");
		const steps = routeSteps([
			{ id: "START", type: "start", outputs: { next: { elementId: "split" } } },
			{ id: "split", type: "conditional", properties: { conditions: { "metadata.tier": { $eq: "pro" } } }, outputs: { true: { elementId: "budget" }, false: { elementId: "small" } } },
			{ id: "budget", type: "rate", properties: { limitType: "cost", key: "metadata.tier", limit: 1, window: 86400 }, outputs: { success: { elementId: "big" }, fallback: { elementId: "medium" } } },
			{ id: "big", type: "model", properties: { provider: "workers-ai", model: "big" }, outputs: { success: { elementId: "END" } } },
			{ id: "medium", type: "model", properties: { provider: "workers-ai", model: "medium" }, outputs: { success: { elementId: "END" } } },
			{ id: "small", type: "model", properties: { provider: "workers-ai", model: "small" }, outputs: { success: { elementId: "END" }, fallback: { elementId: "tiny" } } },
			{ id: "tiny", type: "model", properties: { provider: "workers-ai", model: "tiny" }, outputs: { success: { elementId: "END" } } },
			{ id: "END", type: "end", outputs: {} },
		]);
		expect(steps[1]).toMatchObject({ type: "conditional", condition: 'metadata.tier = "pro"', next: { true: "budget", false: "small" } });
		expect(steps[2]).toMatchObject({ limit: { kind: "cost", key: "metadata.tier", limit: 1, windowSeconds: 86400 } });
		expect(routeModels(steps)).toEqual(["big", "medium", "small", "tiny"]);
	});

	it("reads every gateway and its routes, and says when the token lacks AI Gateway: Read", async () => {
		mockRest({
			"/ai-gateway/gateways": { success: true, result: [GATEWAY] },
			"/ai-gateway/gateways/guarded/routes": { success: true, data: { routes: [{ id: "r1", name: "demo" }] } },
			"/ai-gateway/gateways/guarded/routes/r1": {
				success: true,
				result: { version: { data: [{ id: "START", type: "start", outputs: { next: { elementId: "m" } } }, { id: "m", type: "model", properties: { model: "only" }, outputs: {} }] } },
			},
		});
		const result = await fetchAiGatewayConfig(ACC, "t");
		expect(result.error).toBeNull();
		expect(result.routes).toEqual([expect.objectContaining({ gateway: "guarded", name: "demo", model: "dynamic/demo", models: ["only"] })]);
		mockRest({ "/ai-gateway/gateways": { success: false, status: 403, errors: [{ code: 10000, message: "Authentication error" }] } });
		expect(await fetchAiGatewayConfig(ACC, "t")).toMatchObject({ gateways: [], routes: [], error: "The API token lacks AI Gateway: Read" });
		expect(result.categoryNames).toMatchObject({ P1: "Prompt Injection", S14: "Code Interpreter Abuse" });
	});
});

describe("refusals", () => {
	it("says why each failed request failed, from its named fields", () => {
		const r = (log: Parameters<typeof refusalOf>[1]) => refusalOf("g", log).reason;
		expect(r({ status_code: 424, model: "m", guardrails: { prompt: { P1: "BLOCK", S1: "FLAG" }, response: {} } })).toBe("guardrails");
		expect(refusalOf("g", { status_code: 424, guardrails: { prompt: { P1: "BLOCK", S1: "FLAG" }, response: { S9: "BLOCK" } } }).categories).toEqual([
			{ side: "prompt", code: "P1" },
			{ side: "response", code: "S9" },
		]);
		// Through the Workers AI binding a block answers 422 and logs no category.
		expect(r({ status_code: 422, model: "dynamic/demo", guardrails: null })).toBe("guardrails-unlogged");
		// The guard model's own calls are logged too; their failure is the check failing, not a block.
		expect(r({ status_code: 424, model: "@cf/meta/llama-guard-3-8b", guardrails: { prompt: {}, response: {} } })).toBe("guardrail-check");
		expect(r({ status_code: 400, dlp_action: "BLOCK" })).toBe("dlp");
		expect(r({ status_code: 429, rejection_reason: "rate_limited" })).toBe("rate-limited");
		expect(r({ status_code: 402, rejection_reason: "payment_defaulted" })).toBe("payment");
		expect(r({ status_code: 402 })).toBe("payment");
		expect(r({ status_code: 499 })).toBe("cancelled");
		expect(r({ status_code: 400 })).toBe("error");
	});

	it("groups refusals by reason, category and side, busiest first", () => {
		const rows = [
			refusalOf("a", { status_code: 424, guardrails: { prompt: { P1: "BLOCK" } } }),
			refusalOf("b", { status_code: 424, guardrails: { prompt: { P1: "BLOCK" } } }),
			refusalOf("a", { status_code: 429, rejection_reason: "rate_limited" }),
		];
		expect(groupRefusals(rows)).toEqual([
			{ reason: "guardrails", detail: "P1", side: "prompt", count: 2, gateways: ["a", "b"] },
			{ reason: "rate-limited", detail: "rate_limited", side: null, count: 1, gateways: ["a"] },
		]);
	});

	it("reads each logging gateway's failed requests in the window, and nothing of their prompts, answers or metadata", async () => {
		const secret = { request: "PROMPT-SECRET 6-0048-53656-38-2", response: "ANSWER-SECRET", metadata: '{"user":"META-SECRET@example.com"}' };
		const calls = mockRest({
			"/ai-gateway/gateways": { success: true, result: [GATEWAY, { id: "quiet", collect_logs: false }] },
			"/ai-gateway/gateways/guarded/logs": {
				success: true,
				result_info: { total_count: 2 },
				result: [
					{ ...secret, created_at: "2026-11-05T10:00:00Z", model: "m", provider: "workers-ai", status_code: 424, guardrails: { prompt: { P1: "BLOCK" }, response: {} } },
					{ ...secret, created_at: "2026-11-05T11:00:00Z", model: "dynamic/demo", provider: "unknown", status_code: 422, guardrails: null },
				],
			},
		});
		const result = await fetchAiGatewayRefusals(ACC, "t", "2026-11-01T00:00:00Z", "2026-11-06T00:00:00Z");
		expect(result).toMatchObject({ total: 2, read: 2, error: null, failed: [] });
		expect(result.recent.map((r) => [r.at, r.reason])).toEqual([
			["2026-11-05T11:00:00Z", "guardrails-unlogged"],
			["2026-11-05T10:00:00Z", "guardrails"],
		]);
		expect(JSON.stringify(result)).not.toMatch(/SECRET|6-0048/);
		// Only gateways that keep logs are asked, for failures in the window, newest first.
		const logCalls = calls.filter((u) => u.includes("/logs"));
		expect(logCalls).toHaveLength(1);
		const q = new URL(logCalls[0]).searchParams;
		expect(Object.fromEntries(q)).toMatchObject({ success: "false", start_date: "2026-11-01T00:00:00Z", end_date: "2026-11-06T00:00:00Z", per_page: "50", order_by: "created_at" });
	});
});

describe("logs follow the page's slice", () => {
	const WINDOW = ["2026-11-01T00:00:00Z", "2026-11-06T00:00:00Z"] as const;
	const GATEWAYS = { success: true, result: [GATEWAY, { ...GATEWAY, id: "other" }] };

	it("asks only the drilled gateway, and lets Cloudflare match the model, provider and user", async () => {
		const calls = mockRest({ "/ai-gateway/gateways": GATEWAYS, "/ai-gateway/gateways/guarded/logs": { success: true, result: [], result_info: { total_count: 0 } } });
		await fetchAiGatewayRefusals(ACC, "t", ...WINDOW, { gateway: "guarded", provider: "workers-ai", model: "m", user: "alice@example.com" });
		const logCalls = calls.filter((u) => u.includes("/logs"));
		expect(logCalls).toHaveLength(1);
		expect(logCalls[0]).toContain("/gateways/guarded/logs");
		expect(JSON.parse(new URL(logCalls[0]).searchParams.get("filters")!)).toEqual([
			{ key: "provider", operator: "eq", value: ["workers-ai"] },
			{ key: "model", operator: "eq", value: ["m"] },
			{ key: "metadata.key", operator: "eq", value: ["user"] },
			{ key: "metadata.value", operator: "eq", value: ["alice@example.com"] },
		]);
	});

	it("sends no filters for the whole account", async () => {
		const calls = mockRest({ "/ai-gateway/gateways": GATEWAYS });
		await fetchAiGatewayRefusals(ACC, "t", ...WINDOW);
		const logCalls = calls.filter((u) => u.includes("/logs"));
		expect(logCalls).toHaveLength(2);
		expect(new URL(logCalls[0]).searchParams.has("filters")).toBe(false);
	});
});

describe("flagged but allowed", () => {
	const WINDOW = ["2026-11-01T00:00:00Z", "2026-11-06T00:00:00Z"] as const;

	it("reads Guardrails flags by category and side, and DLP flags by policy, once per policy and side", () => {
		expect(
			flagsOf({
				guardrails: { prompt: { P1: "FLAG", S1: "BLOCK" }, response: { S2: "FLAG" } },
				dlp_action: "FLAG",
				dlp_profiles: [
					{ policy_ids: ["Check PII"], check: "REQUEST" },
					{ policy_ids: ["Check PII", "Check PCI"], check: "REQUEST" },
					{ policy_ids: ["Check PII"], check: "RESPONSE" },
				],
			}),
		).toEqual([
			{ kind: "guardrails", detail: "P1", side: "prompt" },
			{ kind: "guardrails", detail: "S2", side: "response" },
			{ kind: "dlp", detail: "Check PII", side: "prompt" },
			{ kind: "dlp", detail: "Check PCI", side: "prompt" },
			{ kind: "dlp", detail: "Check PII", side: "response" },
		]);
		expect(flagsOf({ dlp_action: "FLAG", dlp_profiles: null })).toEqual([{ kind: "dlp", detail: "(policy not named)", side: null }]);
		expect(flagsOf({ dlp_action: "BLOCK", guardrails: null })).toEqual([]);
	});

	it("scans only gateways that can flag and keep logs, counts guard-model calls apart, and passes nothing on", async () => {
		const secret = { request: "PROMPT-SECRET", response: "ANSWER-SECRET", metadata: '{"user":"META-SECRET@example.com"}' };
		const calls = mockRest({
			"/ai-gateway/gateways": { success: true, result: [GATEWAY, { id: "plain", collect_logs: true, guardrails: null }, { ...GATEWAY, id: "nologs", collect_logs: false }] },
			"/ai-gateway/gateways/guarded/logs": {
				success: true,
				result_info: { total_count: 3 },
				result: [
					{ ...secret, model: "m", guardrails: { prompt: { P1: "FLAG" }, response: {} } },
					{ ...secret, model: "@cf/meta/llama-guard-3-8b", dlp_action: "FLAG", dlp_profiles: [{ policy_ids: ["Check PII"], check: "REQUEST" }] },
					{ ...secret, model: "m", guardrails: { prompt: {}, response: {} } },
				],
			},
		});
		const result = await fetchAiGatewayFlags(ACC, "t", ...WINDOW);
		expect(result).toMatchObject({ flagged: 2, scanned: 3, total: 3, skipped: [], failed: [], error: null });
		expect(result.groups).toEqual([
			{ kind: "guardrails", detail: "P1", side: "prompt", count: 1, onGuardModel: 0, gateways: ["guarded"] },
			{ kind: "dlp", detail: "Check PII", side: "prompt", count: 1, onGuardModel: 1, gateways: ["guarded"] },
		]);
		expect(JSON.stringify(result)).not.toMatch(/SECRET/);
		const logCalls = calls.filter((u) => u.includes("/logs"));
		expect(logCalls).toHaveLength(1);
		expect(new URL(logCalls[0]).searchParams.get("success")).toBe("true");
	});

	it("stops at its bounds and says what it left out", async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ ...GATEWAY, id: `g${i}` }));
		const fullPage = { success: true, result_info: { total_count: 900 }, result: Array.from({ length: 50 }, () => ({ model: "m" })) };
		const routes: Record<string, unknown> = { "/ai-gateway/gateways": { success: true, result: many } };
		for (const g of many) routes[`/ai-gateway/gateways/${g.id}/logs`] = fullPage;
		const calls = mockRest(routes);
		const result = await fetchAiGatewayFlags(ACC, "t", ...WINDOW);
		expect(result.skipped).toEqual(["g8", "g9"]);
		expect(calls.filter((u) => u.includes("/logs"))).toHaveLength(8 * 5);
		expect(result).toMatchObject({ scanned: 8 * 250, total: 8 * 900 });
	});
});

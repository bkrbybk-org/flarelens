import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_AI_GATEWAY_RANGE_MS, isAiGatewayGranularity, isSensitiveTagKey, maskTagValue, type AiGatewayUsageResult } from "../src/lib/ai-gateway";

/**
 * Cover for the AI Gateway route: series/totals fold, rate arithmetic (never divide by zero),
 * per-dataset degradation when a guessed field name is wrong, validation, auth, no-store, 502.
 *
 * Field names queried here are themselves unverified guesses (see the note at the top of
 * src/lib/ai-gateway.ts) — these tests pin the *code's behaviour* against a mocked upstream,
 * not the real Cloudflare schema, which cannot be reached from this environment.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlBodies: { query: string }[] = [];

const row = (dims: Record<string, string | number>, count: number, sum: Record<string, number> = {}) => ({
	count,
	dimensions: dims,
	sum,
});

/** The four dataset names an account with AI Gateway exposes. */
const DEFAULT_DATASETS = [
	"aiGatewayRequestsAdaptiveGroups",
	"aiGatewayErrorsAdaptiveGroups",
	"aiGatewayCacheAdaptiveGroups",
	"aiGatewaySpendSessionsAdaptiveGroups",
];

/**
 * Aggregates and dimensions per dataset, keyed by dataset name. These are the names the code
 * discovers rather than assumes — the point of the probe is that a different spelling here
 * changes the emitted query instead of breaking it.
 */
const DEFAULT_SCHEMA = {
	sums: {
		aiGatewayRequestsAdaptiveGroupsType: ["totalTokensIn", "totalTokensOut"],
		aiGatewaySpendSessionsAdaptiveGroupsType: ["totalCost"],
	} as Record<string, string[]>,
	dimensions: {
		aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "gatewayId", "model", "provider"],
		aiGatewayCacheAdaptiveGroupsType: ["cacheStatus"],
		aiGatewayErrorsAdaptiveGroupsType: ["errorCode"],
	} as Record<string, string[]>,
};

interface MockOpts {
	datasets?: string[];
	schema?: { sums: Record<string, string[]>; dimensions: Record<string, string[]> };
	primary?: Record<string, unknown>;
	primaryFail?: boolean;
	errorsAccount?: Record<string, unknown>;
	errorsFail?: boolean;
	cacheAccount?: Record<string, unknown>;
	cacheFail?: boolean;
	spendAccount?: Record<string, unknown>;
	spendFail?: boolean;
	sessionsAccount?: Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function mockUpstream(opts: MockOpts) {
	graphqlBodies = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.includes("/graphql")) {
			return jsonResponse({ success: true, result: [] });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: { name?: string } };
		graphqlBodies.push(body);
		const q = body.query;

		// Field names are resolved from the schema at runtime, so the mock has to answer
		// introspection before any data query is issued. This is also where a "field absent"
		// case is expressed: drop a name from these lists and the code must degrade, not guess.
		if (q.includes("ProbeAccount")) {
			return jsonResponse({
				data: {
					__type: {
						fields: (opts.datasets ?? DEFAULT_DATASETS).map((name) => ({ name, type: { name: `${name}Type`, ofType: null } })),
					},
				},
			});
		}
		if (q.includes("ProbeType")) {
			const name = String(body.variables?.name ?? "");
			// Row type: point `sum` and `dimensions` at their own probe-able types.
			if (name.endsWith("AdaptiveGroupsType")) {
				return jsonResponse({
					data: {
						__type: {
							fields: [
								{ name: "count", type: { name: "uint64", ofType: null } },
								{ name: "sum", type: { name: `${name}Sum`, ofType: null } },
								{ name: "dimensions", type: { name: `${name}Dimensions`, ofType: null } },
								{ name: "uniq", type: { name: `${name}Uniq`, ofType: null } },
							],
						},
					},
				});
			}
			const schema = opts.schema ?? DEFAULT_SCHEMA;
			const names = name.endsWith("Sum")
				? schema.sums[name.replace("Sum", "")] ?? []
				: name.endsWith("Uniq")
					? (schema as { uniq?: Record<string, string[]> }).uniq?.[name.replace("Uniq", "")] ?? []
					: schema.dimensions[name.replace("Dimensions", "")] ?? [];
			return jsonResponse({ data: { __type: { fields: names.map((n) => ({ name: n, type: { name: "string", ofType: null } })) } } });
		}

		if (q.includes("AiGatewayErrors")) {
			if (opts.errorsFail) return jsonResponse({ errors: [{ message: "unknown field on AiGatewayErrorsAdaptiveGroups" }] });
			return jsonResponse({ data: { viewer: { accounts: [opts.errorsAccount ?? { total: [] }] } } });
		}
		if (q.includes("AiGatewayCache")) {
			if (opts.cacheFail) return jsonResponse({ errors: [{ message: "unknown field on AiGatewayCacheAdaptiveGroups" }] });
			return jsonResponse({ data: { viewer: { accounts: [opts.cacheAccount ?? { byStatus: [] }] } } });
		}
		if (q.includes("AiGatewaySessions")) {
			return jsonResponse({ data: { viewer: { accounts: [opts.sessionsAccount ?? {}] } } });
		}
		if (q.includes("AiGatewaySpend")) {
			if (opts.spendFail) return jsonResponse({ errors: [{ message: "unknown field on AiGatewaySpendSessionsAdaptiveGroups" }] });
			return jsonResponse({ data: { viewer: { accounts: [opts.spendAccount ?? { total: [] }] } } });
		}
		// AiGatewayRequests — the load-bearing primary query
		if (opts.primaryFail) return jsonResponse({ errors: [{ message: "unknown field on AiGatewayRequestsAdaptiveGroups" }] });
		return jsonResponse({ data: { viewer: { accounts: [opts.primary ?? {}] } } });
	}) as typeof fetch;
}

const win = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() });
const usage = (body: Record<string, unknown>) =>
	app.request("/api/ai-gateway/usage", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV);

const DEFAULT_PRIMARY = {
	series: [
		row({ datetimeHour: "2026-09-05T10:00:00Z" }, 100, { totalTokensIn: 500, totalTokensOut: 200 }),
		row({ datetimeHour: "2026-09-05T09:00:00Z" }, 40, { totalTokensIn: 150, totalTokensOut: 60 }),
	],
	byGateway: [row({ gatewayId: "prod" }, 120), row({ gatewayId: "staging" }, 20)],
	byModel: [row({ model: "@cf/meta/llama-3.2-3b-instruct", provider: "workers-ai" }, 90)],
};

beforeEach(() => {
	mockUpstream({
		primary: DEFAULT_PRIMARY,
		errorsAccount: { total: [row({}, 5)] },
		cacheAccount: {
			byStatus: [row({ cacheStatus: "HIT" }, 30), row({ cacheStatus: "MISS" }, 70)],
		},
		spendAccount: { total: [row({}, 0, { totalCost: 12.5 })] },
	});
});
afterEach(() => vi.restoreAllMocks());

describe("series and totals", () => {
	it("folds series rows into one point per bucket, in time order", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { series: { ts: string; requests: number }[] };
		};
		expect(result.series).toEqual([
			{ ts: "2026-09-05T09:00:00Z", requests: 40, tokens: 210, cost: null, errors: null },
			{ ts: "2026-09-05T10:00:00Z", requests: 100, tokens: 700, cost: null, errors: null },
		]);
	});

	it("sums requests and both token directions across the window", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { requests: number; tokensIn: number; tokensOut: number } };
		};
		expect(result.totals.requests).toBe(140);
		expect(result.totals.tokensIn).toBe(650);
		expect(result.totals.tokensOut).toBe(260);
	});

	it("ranks gateway and model breakdowns by request volume", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { byGateway: { key: string; requests: number }[]; byModel: { key: string; requests: number }[] };
		};
		expect(result.byGateway[0]).toMatchObject({ key: "prod", requests: 120 });
		expect(result.byModel[0].requests).toBe(90);
	});
});

describe("rate arithmetic", () => {
	it("computes error rate and cache hit rate from their own datasets", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { errors: number; errorRate: number; cacheHits: number; cacheMisses: number; cacheHitRate: number } };
		};
		// 5 errors / 140 requests
		expect(result.totals.errors).toBe(5);
		expect(result.totals.errorRate).toBeCloseTo(5 / 140, 5);
		// 30 hits / (30 + 70)
		expect(result.totals.cacheHits).toBe(30);
		expect(result.totals.cacheMisses).toBe(70);
		expect(result.totals.cacheHitRate).toBeCloseTo(0.3, 5);
	});

	it("never divides by zero: a zero-request window reports rates as unavailable, not 0%", async () => {
		mockUpstream({
			primary: { series: [], byGateway: [], byModel: [] },
			errorsAccount: { total: [] },
			cacheAccount: { byStatus: [] },
			spendAccount: { total: [] },
		});
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { requests: number; errorRate: number | null; cacheHitRate: number | null; errors: number; cost: number | null } };
		};
		expect(result.totals.requests).toBe(0);
		expect(result.totals.errorRate).toBeNull();
		expect(result.totals.cacheHitRate).toBeNull();
		// The errors dataset itself still answered (zero rows), so the count is a real 0, not absent.
		expect(result.totals.errors).toBe(0);
		expect(result.totals.cost).toBeNull();
	});
});

describe("per-dataset degradation", () => {
	it("keeps the section working when the errors dataset's guessed field name is wrong", async () => {
		mockUpstream({ primary: DEFAULT_PRIMARY, errorsFail: true, cacheAccount: { byStatus: [] }, spendAccount: { total: [] } });
		const res = await usage({ accountId: ACCOUNT, ...win() });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as {
			result: { totals: { requests: number; errors: number | null; errorRate: number | null }; datasets: { errors: { available: boolean; reason?: string } } };
		};
		expect(result.totals.requests).toBe(140);
		expect(result.totals.errors).toBeNull();
		expect(result.totals.errorRate).toBeNull();
		expect(result.datasets.errors.available).toBe(false);
		expect(result.datasets.errors.reason).toBeTruthy();
	});

	it("degrades the cache panel alone when its dataset fails", async () => {
		mockUpstream({ primary: DEFAULT_PRIMARY, cacheFail: true, errorsAccount: { total: [] }, spendAccount: { total: [] } });
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: {
				totals: { cacheHits: number | null; cacheMisses: number | null; cacheHitRate: number | null };
				datasets: { cache: { available: boolean } };
			};
		};
		expect(result.totals.cacheHits).toBeNull();
		expect(result.totals.cacheMisses).toBeNull();
		expect(result.totals.cacheHitRate).toBeNull();
		expect(result.datasets.cache.available).toBe(false);
	});

	it("degrades the spend panel alone when its dataset fails", async () => {
		mockUpstream({ primary: DEFAULT_PRIMARY, spendFail: true, errorsAccount: { total: [] }, cacheAccount: { byStatus: [] } });
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { cost: number | null }; datasets: { spend: { available: boolean } } };
		};
		expect(result.totals.cost).toBeNull();
		expect(result.datasets.spend.available).toBe(false);
	});

	it("fails the whole request when the load-bearing requests dataset is wrong", async () => {
		mockUpstream({ primaryFail: true });
		expect((await usage({ accountId: ACCOUNT, ...win() })).status).toBe(502);
	});
});

describe("privacy posture", () => {
	it("never asks for a user id, device or IP dimension — users come only from the user tag", async () => {
		await usage({ accountId: ACCOUNT, ...win() });
		const combined = graphqlBodies.map((b) => b.query).join("\n");
		for (const field of ["email", "userId", "deviceId", "sourceInternalIp", "srcIpCountry", "ipAddress"]) {
			expect(combined).not.toContain(field);
		}
	});
});

describe("validation", () => {
	it("rejects bad ids, bad instants, inverted and over-long ranges", async () => {
		expect((await usage({ accountId: "nope", ...win() })).status).toBe(400);
		expect((await usage({ accountId: ACCOUNT, from: "x", to: "y" })).status).toBe(400);
		const w = win();
		expect((await usage({ accountId: ACCOUNT, from: w.to, to: w.from })).status).toBe(400);
		const to = new Date();
		const from = new Date(to.getTime() - MAX_AI_GATEWAY_RANGE_MS - 60_000);
		expect((await usage({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/ai-gateway/usage",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, ...win() }) },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("marks the response no-store", async () => {
		const res = await usage({ accountId: ACCOUNT, ...win() });
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("accepts only supported granularities", () => {
		expect(isAiGatewayGranularity("daily")).toBe(true);
		expect(isAiGatewayGranularity("monthly")).toBe(false);
	});

	it("surfaces a load-bearing GraphQL error as a 502", async () => {
		mockUpstream({ primaryFail: true });
		expect((await usage({ accountId: ACCOUNT, ...win() })).status).toBe(502);
	});
});

describe("overview and drill-down", () => {
	// A different account id: the schema resolution is cached per account, and this one is richer.
	const RICH = "22222222222222222222222222222222";
	const RICH_SCHEMA = {
		sums: { aiGatewayRequestsAdaptiveGroupsType: ["tokensIn", "tokensOut", "cost", "erroredRequests", "cachedRequests"] },
		dimensions: {
			aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "datetime", "gateway", "provider", "model", "statusCode", "rateLimited", "requestId", "durationMs", "cached", "userAgent"],
		},
	};
	const RICH_PRIMARY = {
		series: [row({ datetimeHour: "2026-09-05T10:00:00Z" }, 10, { tokensIn: 100, tokensOut: 20, cost: 0.5, erroredRequests: 1, cachedRequests: 2 })],
		total: [row({}, 10, { tokensIn: 100, tokensOut: 20, cost: 0.5, erroredRequests: 1, cachedRequests: 2 })],
		previous: [row({}, 20, { tokensIn: 50, tokensOut: 10, cost: 0.25, erroredRequests: 0, cachedRequests: 15 })],
		byGateway: [row({ gateway: "prod" }, 10, { tokensIn: 100, tokensOut: 20, cost: 0.5, erroredRequests: 1, cachedRequests: 2 })],
		byProvider: [row({ provider: "workers-ai" }, 10, { cost: 0.5 })],
		byModel: [row({ model: "@cf/a" }, 7, { cost: 0.4 }), row({ model: "@cf/b" }, 3, { cost: 0.1 })],
		byStatus: [row({ statusCode: 200, rateLimited: 0 }, 9), row({ statusCode: 429, rateLimited: 1 }, 1)],
		recent: [
			row({ requestId: "r1", datetime: "2026-09-05T10:05:00Z", gateway: "prod", provider: "workers-ai", model: "@cf/a", statusCode: 200, durationMs: 1200, cached: 1, rateLimited: 0, userAgent: "app/1" }, 1, {
				tokensIn: 10,
				tokensOut: 2,
				cost: 0.01,
			}),
		],
	};

	beforeEach(() => mockUpstream({ schema: RICH_SCHEMA, primary: RICH_PRIMARY }));

	it("returns the previous window, status codes, rate limiting and the latest requests", async () => {
		const res = await usage({ accountId: RICH, ...win() });
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		expect(result.totals).toMatchObject({ requests: 10, cost: 0.5, errors: 1, cacheHits: 2, rateLimited: 1 });
		expect(result.previous).toEqual({ requests: 20, sessions: null, tokens: 60, cost: 0.25, errorRate: 0, cacheHitRate: 0.75, p50: null });
		expect(result.byStatus).toEqual([
			{ statusCode: "200", rateLimited: false, requests: 9 },
			{ statusCode: "429", rateLimited: true, requests: 1 },
		]);
		expect(result.byModel.map((r) => [r.key, r.cost])).toEqual([
			["@cf/a", 0.4],
			["@cf/b", 0.1],
		]);
		expect(result.recent[0]).toEqual({
			requestId: "r1",
			datetime: "2026-09-05T10:05:00Z",
			gateway: "prod",
			provider: "workers-ai",
			model: "@cf/a",
			statusCode: "200",
			durationMs: 1200,
			cached: true,
			rateLimited: false,
			tokensIn: 10,
			tokensOut: 2,
			cost: 0.01,
			userAgent: "app/1",
			user: "",
		});
		// The previous window is the same length, ending where this one starts.
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests")) as { query: string; variables: Record<string, string> };
		expect(Date.parse(query.variables.prevUntil)).toBe(Date.parse(query.variables.since));
		expect(Date.parse(query.variables.until) - Date.parse(query.variables.since)).toBe(Date.parse(query.variables.prevUntil) - Date.parse(query.variables.prevSince));
	});

	it("splits each bucket by gateway, model and provider, and falls back to hours without 15-minute buckets", async () => {
		mockUpstream({
			schema: RICH_SCHEMA,
			primary: {
				...RICH_PRIMARY,
				seriesByProvider: [row({ datetimeHour: "2026-09-05T10:00:00Z", provider: "workers-ai" }, 8, { cost: 0.4 }), row({ datetimeHour: "2026-09-05T10:00:00Z", provider: "openai" }, 2, { cost: 0.1 })],
			},
		});
		// RICH_SCHEMA has no datetimeFifteenMinutes, so a 15-minute request is answered hourly.
		const res = await usage({ accountId: RICH, ...win(), granularity: "15m" });
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		expect(result.granularity).toBe("hourly");
		expect(result.seriesBy.provider).toEqual([
			{ ts: "2026-09-05T10:00:00Z", key: "workers-ai", requests: 8, tokens: 0, cost: 0.4, errors: 0 },
			{ ts: "2026-09-05T10:00:00Z", key: "openai", requests: 2, tokens: 0, cost: 0.1, errors: 0 },
		]);
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests"))!.query;
		expect(query).toContain("dimensions { datetimeHour gateway }");
		expect(query).toContain("dimensions { datetimeHour model }");
		expect(query).toContain("dimensions { datetimeHour provider }");
	});

	it("counts users and sessions, prompt-cache reads, clients by name, and flagged sessions", async () => {
		const ACCT = "44444444444444444444444444444444";
		mockUpstream({
			datasets: [...DEFAULT_DATASETS],
			schema: {
				sums: {
					aiGatewayRequestsAdaptiveGroupsType: ["tokensIn", "tokensOut", "cost", "cacheReadTokens", "contextTokens", "requestsWithCacheRead"],
					aiGatewaySpendSessionsAdaptiveGroupsType: ["cost"],
				},
				dimensions: {
					aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "gateway", "model", "provider", "userAgent"],
					aiGatewaySpendSessionsAdaptiveGroupsType: ["gateway", "primaryModel", "flagLowCacheHit", "flagAbnormalCost"],
				},
				uniq: { aiGatewayRequestsAdaptiveGroupsType: ["users", "sessions"] },
			} as never,
			primary: {
				series: [],
				total: [{ count: 10, sum: { tokensIn: 60, tokensOut: 5, cost: 1, cacheReadTokens: 40, contextTokens: 100, requestsWithCacheRead: 7 }, uniq: { users: 0, sessions: 3 } }],
				byClient: [
					row({ userAgent: "opencode/1.2.0 (darwin)" }, 4, { cost: 0.4 }),
					row({ userAgent: "opencode/1.3.1 (linux)" }, 3, { cost: 0.3 }),
					row({ userAgent: "Mozilla/5.0 (Macintosh)" }, 2, { cost: 0.2 }),
					row({ userAgent: "pi (linux ; x64)" }, 1, { cost: 0.1 }),
				],
			},
			sessionsAccount: { sessions: [row({}, 12)], lowCacheHit: [row({}, 2)], abnormalCost: [] },
		});
		const res = await usage({ accountId: ACCT, ...win(), filter: { gateway: "prod" } });
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		expect(result.totals).toMatchObject({ users: 0, sessions: 3, promptCache: { readTokens: 40, inputTokens: 100, requestsWithRead: 7 } });
		// Client versions fold into one client; their latencies cannot, so they are dropped.
		expect(result.byClient.map((r) => [r.key, r.requests, r.cost])).toEqual([
			["opencode", 7, 0.7],
			["Browser", 2, 0.2],
			["pi", 1, 0.1],
		]);
		expect(result.byClient[0].p50).toBeNull();
		expect(result.sessionHealth).toEqual({
			available: true,
			sessions: 12,
			basis: "all",
			flags: { abnormalCost: 0, abnormalDuration: null, lowCacheHit: 2, highFirstContext: null, highMcpTools: null, premiumModel: null, thinkingModel: null },
		});
		const sessionsQuery = graphqlBodies.find((b) => b.query.includes("AiGatewaySessions")) as { query: string; variables: Record<string, string> };
		expect(sessionsQuery.query).toContain("gateway: $f_gateway");
		expect(sessionsQuery.query).toContain("flagLowCacheHit: 1");
		expect(sessionsQuery.query).not.toContain("userId");
		expect(sessionsQuery.variables.f_gateway).toBe("prod");
	});

	it("breaks spend down by a tag, with the untagged remainder and identifying values masked", async () => {
		const ACCT = "55555555555555555555555555555555";
		mockUpstream({
			schema: {
				sums: { aiGatewayRequestsAdaptiveGroupsType: ["cost"] },
				dimensions: { aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "gateway", "metadataKey", "metadataValue", "metadataKeys"] },
			},
			primary: {
				series: [],
				total: [row({}, 10, { cost: 1 })],
				tagKeys: [row({ metadataKey: "team" }, 8), row({ metadataKey: "user" }, 6)],
				byTag: [row({ metadataValue: "search" }, 5, { cost: 0.5 }), row({ metadataValue: "a.person@example.com" }, 2, { cost: 0.2 }), row({ metadataValue: "" }, 1, { cost: 0.1 })],
				seriesByTag: [row({ datetimeHour: "2026-09-05T10:00:00Z", metadataValue: "search" }, 5, { cost: 0.5 })],
			},
		});
		const res = await usage({ accountId: ACCT, ...win(), tag: "team" });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		expect(result.tags!.keys).toEqual([
			{ key: "team", requests: 8, sensitive: false },
			{ key: "user", requests: 6, sensitive: true },
		]);
		expect(result.tags!.rows.map((r) => [r.key, r.requests, Math.round((r.cost ?? 0) * 1000) / 1000])).toEqual([
			["search", 5, 0.5],
			["(someone)@example.com", 2, 0.2],
			["(empty)", 1, 0.1],
			["(not tagged)", 2, 0.2],
		]);
		expect(result.tags!.series).toHaveLength(1);
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests")) as { query: string; variables: Record<string, string> };
		expect(query.query).toContain("metadataValue(key: $tagKey)");
		expect(query.query).toContain("metadataKeys_has: $tagKey");
		expect(query.query).not.toContain('"team"');
		expect(query.variables.tagKey).toBe("team");
		// Nothing in the response carries the address itself.
		expect(JSON.stringify(result)).not.toContain("a.person");
	});

	it("breaks usage down per user from the user tag, values as sent, with the untagged remainder", async () => {
		const ACCT = "66666666666666666666666666666666";
		mockUpstream({
			schema: {
				sums: { aiGatewayRequestsAdaptiveGroupsType: ["tokensIn", "tokensOut", "cost"] },
				dimensions: { aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "datetime", "requestId", "gateway", "metadataKey", "metadataValue", "metadataKeys", "metadataValues"] },
			},
			primary: {
				series: [],
				total: [row({}, 10, { tokensIn: 1000, tokensOut: 100, cost: 2 })],
				byUser: [row({ metadataValue: "alice@example.com" }, 6, { tokensIn: 700, tokensOut: 60, cost: 1.5 }), row({ metadataValue: " bob@example.com " }, 1, { tokensIn: 100, tokensOut: 10, cost: 0.2 })],
				seriesByUser: [row({ datetimeHour: "2026-09-05T10:00:00Z", metadataValue: "alice@example.com" }, 6, { cost: 1.5 })],
				recent: [row({ requestId: "r1", datetime: "2026-09-05T10:05:00Z", gateway: "prod", metadataValue: "alice@example.com" }, 1)],
			},
		});
		const res = await usage({ accountId: ACCT, ...win() });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		// Full addresses, as decided for the user key — unlike any other tag.
		expect(result.byUser!.map((r) => [r.key, r.requests, r.tokensIn, Math.round((r.cost ?? 0) * 1000) / 1000])).toEqual([
			["alice@example.com", 6, 700, 1.5],
			["bob@example.com", 1, 100, 0.2],
			["(not tagged)", 3, 200, 0.3],
		]);
		expect(result.seriesBy.user).toEqual([{ ts: "2026-09-05T10:00:00Z", key: "alice@example.com", requests: 6, tokens: 0, cost: 1.5, errors: null }]);
		expect(result.recent[0].user).toBe("alice@example.com");
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests")) as { query: string; variables: Record<string, string> };
		expect(query.query).toContain("metadataValue(key: $userKey)");
		expect(query.query).toContain("metadataKeys_has: $userKey");
		expect(query.query).not.toContain('"user"');
		expect(query.variables.userKey).toBe("user");
	});

	it("drills into one user with the value as a variable, and says session analysis cannot follow", async () => {
		const ACCT = "77777777777777777777777777777777";
		mockUpstream({
			datasets: [...DEFAULT_DATASETS],
			schema: {
				sums: { aiGatewayRequestsAdaptiveGroupsType: ["cost"], aiGatewaySpendSessionsAdaptiveGroupsType: ["cost"] },
				dimensions: {
					aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date", "gateway", "metadataKey", "metadataValue", "metadataKeys", "metadataValues"],
					aiGatewaySpendSessionsAdaptiveGroupsType: ["gateway", "flagLowCacheHit"],
				},
			},
			primary: { series: [], total: [row({}, 6, { cost: 1.5 })], byUser: [row({ metadataValue: "alice@example.com" }, 6, { cost: 1.5 })] },
		});
		const res = await usage({ accountId: ACCT, ...win(), filter: { user: 'alice@example.com" } evil' } });
		expect(res.status).toBe(200);
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests")) as { query: string; variables: Record<string, string> };
		expect(query.query).not.toContain("evil");
		expect(query.query).toContain("AND: [{ metadataKeys_has: $f_userKey }, { metadataValues_has: $f_user }]");
		// The per-user breakdown adds its own key test beside it, never a second field of the same name.
		expect(query.query).toMatch(/byUser: \w+\(filter: \{[^}]*AND: \[[^\]]*\], metadataKeys_has: \$userKey \}/);
		expect(query.variables).toMatchObject({ f_user: 'alice@example.com" } evil', f_userKey: "user" });
		const { result } = (await res.json()) as { result: AiGatewayUsageResult };
		expect(result.filter).toEqual({ user: 'alice@example.com" } evil' });
		expect(result.sessionHealth).toEqual({ available: false, reason: "Session analysis cannot be narrowed to one user" });
		// The sessions dataset was never asked: it would have answered for everyone.
		expect(graphqlBodies.some((b) => b.query.includes("AiGatewaySessions"))).toBe(false);
	});

	it("refuses a user filter the schema cannot apply, and a malformed one", async () => {
		const res = await usage({ accountId: RICH, ...win(), filter: { user: "alice@example.com" } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: { message: string }[] }).errors[0].message).toContain("cannot be filtered by user");
		expect((await usage({ accountId: RICH, ...win(), filter: { user: "a\nb@example.com" } })).status).toBe(400);
		expect((await usage({ accountId: RICH, ...win(), filter: { user: "x".repeat(321) } })).status).toBe(400);
		expect((await usage({ accountId: RICH, ...win(), filter: { user: 5 } })).status).toBe(400);
	});

	it("refuses a tag that identifies people, and a malformed one", async () => {
		mockUpstream({ schema: RICH_SCHEMA, primary: RICH_PRIMARY });
		const refused = await usage({ accountId: RICH, ...win(), tag: "user" });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { errors: { message: string }[] }).errors[0].message).toContain("identifies people");
		expect((await usage({ accountId: RICH, ...win(), tag: "team} evil" })).status).toBe(400);
		expect((await usage({ accountId: RICH, ...win(), tag: 7 })).status).toBe(400);
	});

	it("drills into a slice with the values as variables, never in the query text", async () => {
		const res = await usage({ accountId: RICH, ...win(), filter: { gateway: 'prod" } evil', model: "@cf/a" } });
		expect(res.status).toBe(200);
		const query = graphqlBodies.find((b) => b.query.includes("AiGatewayRequests")) as { query: string; variables: Record<string, string> };
		expect(query.query).not.toContain("evil");
		expect(query.query).toContain("gateway: $f_gateway");
		expect(query.query).toContain("model: $f_model");
		expect(query.variables).toMatchObject({ f_gateway: 'prod" } evil', f_model: "@cf/a" });
		const { result } = (await res.json()) as { result: { filter: Record<string, string> } };
		expect(result.filter).toEqual({ gateway: 'prod" } evil', model: "@cf/a" });
	});

	it("refuses a filter the schema cannot apply, and a malformed one", async () => {
		// A schema with no model dimension cannot honour a model filter; ignoring it would show the whole account as the slice.
		mockUpstream({ schema: { sums: {}, dimensions: { aiGatewayRequestsAdaptiveGroupsType: ["datetimeHour", "date"] } }, primary: {} });
		const THIN = "33333333333333333333333333333333";
		const res = await usage({ accountId: THIN, ...win(), filter: { model: "@cf/a" } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: { message: string }[] }).errors[0].message).toContain("cannot be filtered by model");
		expect((await usage({ accountId: RICH, ...win(), filter: { gateway: 42 } })).status).toBe(400);
		expect((await usage({ accountId: RICH, ...win(), filter: { gateway: "x".repeat(300) } })).status).toBe(400);
	});
});

describe("tag privacy", () => {
	it("treats keys naming people or single items as sensitive, and cost centers as not", () => {
		for (const key of ["user", "userId", "email", "user_email", "gadgetId", "chatId", "cf.session_id", "customer", "ip"]) expect(isSensitiveTagKey(key)).toBe(true);
		for (const key of ["team", "costCenter", "cost-center", "source", "task", "origin", "ai-search", "tier", "feature"]) expect(isSensitiveTagKey(key)).toBe(false);
	});

	it("masks emails to their domain and long identifiers, and names an empty value", () => {
		expect(maskTagValue("someone@example.co.th")).toBe("(someone)@example.co.th");
		expect(maskTagValue("b95f90995eaed87c4e2ee17f8a99714c")).toBe("(identifier)");
		expect(maskTagValue("  ")).toBe("(empty)");
		expect(maskTagValue("CC-1042")).toBe("CC-1042");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_AI_GATEWAY_RANGE_MS, isAiGatewayGranularity } from "../src/lib/ai-gateway";

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
							],
						},
					},
				});
			}
			const schema = opts.schema ?? DEFAULT_SCHEMA;
			const names = name.endsWith("Sum")
				? schema.sums[name.replace("Sum", "")] ?? []
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
			{ ts: "2026-09-05T09:00:00Z", requests: 40 },
			{ ts: "2026-09-05T10:00:00Z", requests: 100 },
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
		expect(result.byGateway[0]).toEqual({ key: "prod", requests: 120 });
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
	it("never asks for a per-user, per-device or per-IP dimension", async () => {
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

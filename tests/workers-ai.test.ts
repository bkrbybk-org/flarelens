import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_AI_RANGE_MS, isAiGranularity } from "../src/lib/workers-ai";
import { formatCompact, formatLatency, metricOf, shortModel } from "../web/src/features/workers-ai/types";

/** Cover for the Workers AI route: error folding, per-model rollup, validation, formatting. */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlBodies: { query: string; variables: Record<string, unknown> }[] = [];

const row = (dims: Record<string, string | number>, count: number, sum: Record<string, number> = {}) => ({
	count,
	dimensions: dims,
	sum: { totalNeurons: 0, totalInputTokens: 0, totalOutputTokens: 0, totalInferenceTimeMs: 0, ...sum },
});

function mockUpstream(account: Record<string, unknown>) {
	graphqlBodies = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/graphql")) {
			graphqlBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ success: true, result: [] }), { headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const win = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() });
const usage = (body: Record<string, unknown>) =>
	app.request("/api/workers-ai/usage", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV);

beforeEach(() => {
	mockUpstream({
		series: [
			row({ datetimeHour: "2026-09-04T10:00:00Z", errorCode: 0 }, 10, { totalNeurons: 5.5, totalInputTokens: 100, totalOutputTokens: 40, totalInferenceTimeMs: 5000 }),
			row({ datetimeHour: "2026-09-04T10:00:00Z", errorCode: 3006 }, 2, { totalInferenceTimeMs: 200 }),
			row({ datetimeHour: "2026-09-04T09:00:00Z", errorCode: 0 }, 4, { totalNeurons: 1.25 }),
		],
		byModel: [
			row({ modelId: "@cf/meta/llama-3.2-3b-instruct", errorCode: 0 }, 20, { totalNeurons: 117.7, totalInferenceTimeMs: 20740 }),
			row({ modelId: "@cf/meta/llama-3.2-3b-instruct", errorCode: 3006 }, 2, { totalInferenceTimeMs: 260 }),
		],
		bySource: [row({ requestSource: "workers-binding" }, 20, { totalNeurons: 43.6 })],
		byError: [row({ errorCode: 0 }, 24), row({ errorCode: 3006 }, 2)],
	});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/workers-ai/usage", () => {
	it("folds error and success rows into one point per bucket", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { series: { ts: string; requests: number; errors: number; neurons: number }[] };
		};
		expect(result.series.map((p) => p.ts)).toEqual(["2026-09-04T09:00:00Z", "2026-09-04T10:00:00Z"]);
		const latest = result.series[1];
		expect(latest.requests).toBe(12);
		// errorCode 0 is "no error"; only the 3006 rows count as failures.
		expect(latest.errors).toBe(2);
		expect(latest.neurons).toBeCloseTo(5.5);
	});

	it("totals the window across buckets", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { requests: number; errors: number; inputTokens: number; outputTokens: number } };
		};
		expect(result.totals.requests).toBe(16);
		expect(result.totals.errors).toBe(2);
		expect(result.totals.inputTokens).toBe(100);
		expect(result.totals.outputTokens).toBe(40);
	});

	it("rolls a model's error and success rows together and derives average latency", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { byModel: { modelId: string; requests: number; errors: number; avgLatencyMs: number }[] };
		};
		const model = result.byModel[0];
		expect(model.modelId).toBe("@cf/meta/llama-3.2-3b-instruct");
		expect(model.requests).toBe(22);
		expect(model.errors).toBe(2);
		// (20740 + 260) / 22
		expect(model.avgLatencyMs).toBeCloseTo(954.5, 1);
	});

	it("lists only real error codes, excluding the zero bucket", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { errorsByCode: { code: string; requests: number }[] };
		};
		expect(result.errorsByCode).toEqual([{ code: "3006", requests: 2 }]);
	});

	it("switches to the date dimension for daily granularity", async () => {
		mockUpstream({ series: [row({ date: "2026-09-04", errorCode: 0 }, 3)] });
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win(), granularity: "daily" })).json()) as {
			result: { timeDimension: string; series: { ts: string }[] };
		};
		expect(result.timeDimension).toBe("date");
		expect(result.series[0].ts).toBe("2026-09-04");
	});

	it("passes the window as GraphQL variables", async () => {
		const w = win();
		await usage({ accountId: ACCOUNT, ...w });
		expect(graphqlBodies[0].variables.since).toBe(new Date(w.from).toISOString());
		expect(graphqlBodies[0].variables.accountTag).toBe(ACCOUNT);
	});

	it("validates ids, instants, ordering and range width", async () => {
		expect((await usage({ accountId: "nope", ...win() })).status).toBe(400);
		expect((await usage({ accountId: ACCOUNT, from: "soon", to: "later" })).status).toBe(400);
		const w = win();
		expect((await usage({ accountId: ACCOUNT, from: w.to, to: w.from })).status).toBe(400);
		const to = new Date();
		const from = new Date(to.getTime() - MAX_AI_RANGE_MS - 60_000);
		expect((await usage({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/workers-ai/usage",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, ...win() }) },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("surfaces a GraphQL error as a 502", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { headers: { "Content-Type": "application/json" } }),
		) as typeof fetch;
		expect((await usage({ accountId: ACCOUNT, ...win() })).status).toBe(502);
	});

	it("accepts only supported granularities", () => {
		expect(isAiGranularity("daily")).toBe(true);
		expect(isAiGranularity("yearly")).toBe(false);
	});
});

describe("presentation helpers", () => {
	it("keeps fractional neuron counts readable instead of rounding them to zero", () => {
		expect(formatCompact(0.42)).toBe("0.42");
		expect(formatCompact(185.29)).toBe("185.29");
		expect(formatCompact(2400)).toBe("2.4K");
		expect(formatCompact(31)).toBe("31");
	});

	it("formats latency in ms or seconds", () => {
		expect(formatLatency(480)).toBe("480 ms");
		expect(formatLatency(1037)).toBe("1.04 s");
		expect(formatLatency(null)).toBe("—");
	});

	it("shortens a model id but keeps one without a prefix intact", () => {
		expect(shortModel("@cf/meta/llama-3.2-3b-instruct")).toBe("llama-3.2-3b-instruct");
		expect(shortModel("custom-model")).toBe("custom-model");
	});

	it("selects the charted metric, combining both token directions", () => {
		const point = { requests: 5, neurons: 2, inputTokens: 10, outputTokens: 4, inferenceTimeMs: 0, errors: 1 };
		expect(metricOf(point, "requests")).toBe(5);
		expect(metricOf(point, "tokens")).toBe(14);
		expect(metricOf(point, "errors")).toBe(1);
	});
});

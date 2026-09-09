import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_RANGE_MS, ROW_LIMIT, isGranularity, parseInstant } from "../src/lib/workers-analytics";
import { errorRate, formatCount, formatCpu, metricValue, totalsOf, workerColor, type WorkerMetricRecord } from "../web/src/features/workers/types";

/**
 * Cover for the Workers Analytics section: input validation at the GraphQL boundary, the route
 * contract, and the aggregation the cards and table are built from.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlBodies: { query: string; variables: Record<string, unknown> }[] = [];

const record = (over: Partial<WorkerMetricRecord> & { scriptName?: string; ts?: string } = {}): WorkerMetricRecord => ({
	dimensions: { scriptName: over.scriptName ?? "flarelens", datetimeHour: over.ts ?? "2026-09-04T10:00:00Z" },
	sum: { requests: 0, errors: 0, subrequests: 0, ...(over.sum ?? {}) },
	quantiles: { cpuTimeP50: over.quantiles?.cpuTimeP50 ?? null },
});

beforeEach(() => {
	graphqlBodies = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/graphql")) {
			graphqlBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(
				JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [record({ sum: { requests: 5, errors: 1, subrequests: 2 } })] }] } } }),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ success: true, result: [{ id: "flarelens" }, { id: "app-delta" }] }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const metrics = (body: Record<string, unknown>) =>
	app.request("/api/workers/metrics", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV);

const window = (hours: number) => ({
	from: new Date(Date.now() - hours * 3_600_000).toISOString(),
	to: new Date().toISOString(),
});

describe("parseInstant", () => {
	it("accepts full UTC instants and re-emits them through toISOString", () => {
		expect(parseInstant("2026-09-04T10:00:00Z")).toBe("2026-09-04T10:00:00.000Z");
		expect(parseInstant("2026-09-04T10:00Z")).toBe("2026-09-04T10:00:00.000Z");
	});

	it("refuses anything that is not an explicit UTC instant", () => {
		// The value is interpolated into a GraphQL document, so this is the injection boundary.
		expect(parseInstant("2026-09-04T10:00")).toBeNull();
		expect(parseInstant("2026-09-04T10:00+07:00")).toBeNull();
		expect(parseInstant("now")).toBeNull();
		expect(parseInstant(12345)).toBeNull();
		expect(parseInstant(`2026-09-04T10:00:00Z${"A".repeat(64)}`)).toBeNull();
	});

	it("validates granularity against the supported set", () => {
		expect(isGranularity("hourly")).toBe(true);
		expect(isGranularity("daily")).toBe(true);
		expect(isGranularity("weekly")).toBe(false);
	});
});

describe("POST /api/workers/metrics", () => {
	it("returns the records with the granularity and time dimension used", async () => {
		const res = await metrics({ accountId: ACCOUNT, ...window(6), granularity: "hourly" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { timeDimension: string; granularity: string; truncated: boolean } };
		expect(body.result.timeDimension).toBe("datetimeHour");
		expect(body.result.granularity).toBe("hourly");
		expect(body.result.truncated).toBe(false);
	});

	it("switches the time dimension for daily granularity", async () => {
		const res = await metrics({ accountId: ACCOUNT, ...window(24 * 20), granularity: "daily" });
		const body = (await res.json()) as { result: { timeDimension: string } };
		expect(body.result.timeDimension).toBe("date");
		expect(graphqlBodies[0].query).toContain("date");
	});

	it("defaults to hourly when granularity is absent or unknown", async () => {
		const res = await metrics({ accountId: ACCOUNT, ...window(6), granularity: "weekly" });
		const body = (await res.json()) as { result: { granularity: string } };
		expect(body.result.granularity).toBe("hourly");
	});

	it("passes the window as GraphQL variables, never as inlined caller text", async () => {
		const win = window(6);
		await metrics({ accountId: ACCOUNT, ...win, granularity: "hourly" });
		expect(graphqlBodies[0].variables.since).toBe(new Date(win.from).toISOString());
		expect(graphqlBodies[0].variables.accountTag).toBe(ACCOUNT);
		expect(graphqlBodies[0].variables.limit).toBe(ROW_LIMIT);
	});

	it("rejects a malformed account id, dates, and inverted ranges", async () => {
		expect((await metrics({ accountId: "nope", ...window(6) })).status).toBe(400);
		expect((await metrics({ accountId: ACCOUNT, from: "yesterday", to: "now" })).status).toBe(400);
		const win = window(6);
		expect((await metrics({ accountId: ACCOUNT, from: win.to, to: win.from })).status).toBe(400);
	});

	it("refuses a range longer than the supported 30 days", async () => {
		const to = new Date();
		const from = new Date(to.getTime() - MAX_RANGE_MS - 60_000);
		const res = await metrics({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() });
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/workers/metrics",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, ...window(6) }) },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("surfaces a GraphQL error as a 502", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { headers: { "Content-Type": "application/json" } }),
		) as typeof fetch;
		const res = await metrics({ accountId: ACCOUNT, ...window(6) });
		expect(res.status).toBe(502);
		expect((await res.json() as { errors: { message: string }[] }).errors[0].message).toContain("unknown field");
	});
});

describe("GET /api/workers/scripts", () => {
	it("returns sorted script names", async () => {
		const res = await app.request(`/api/workers/scripts?account_id=${ACCOUNT}`, { headers: auth }, ENV);
		expect(res.status).toBe(200);
		expect((await res.json() as { result: string[] }).result).toEqual(["app-delta", "flarelens"]);
	});

	it("passes a 403 through so a missing scope reads as a scope problem", async () => {
		// The bound production token lacks Workers Scripts: Read; the UI degrades rather than
		// failing, but the status must still be truthful.
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 }),
		) as typeof fetch;
		const res = await app.request(`/api/workers/scripts?account_id=${ACCOUNT}`, { headers: auth }, ENV);
		expect(res.status).toBe(403);
	});
});

describe("aggregation", () => {
	it("sums counters and averages the per-bucket CPU medians", () => {
		const totals = totalsOf([
			record({ sum: { requests: 10, errors: 1, subrequests: 4 }, quantiles: { cpuTimeP50: 1000 } }),
			record({ sum: { requests: 20, errors: 3, subrequests: 6 }, quantiles: { cpuTimeP50: 3000 } }),
		]);
		expect(totals).toEqual({ requests: 30, errors: 4, subrequests: 10, cpuTimeP50: 2000 });
	});

	it("excludes buckets with no CPU sample instead of counting them as zero", () => {
		const totals = totalsOf([
			record({ quantiles: { cpuTimeP50: 4000 } }),
			record({ quantiles: { cpuTimeP50: null } }),
		]);
		expect(totals.cpuTimeP50).toBe(4000);
	});

	it("reports no CPU figure at all when nothing sampled it", () => {
		expect(totalsOf([record()]).cpuTimeP50).toBeNull();
	});

	it("computes an error rate, and avoids dividing by zero", () => {
		expect(errorRate({ requests: 200, errors: 4, subrequests: 0, cpuTimeP50: null })).toBe(2);
		expect(errorRate({ requests: 0, errors: 0, subrequests: 0, cpuTimeP50: null })).toBe(0);
	});

	it("converts CPU microseconds to milliseconds for the chart", () => {
		expect(metricValue(record({ quantiles: { cpuTimeP50: 6079 } }), "cpu")).toBeCloseTo(6.079);
		expect(metricValue(record({ sum: { requests: 7, errors: 0, subrequests: 0 } }), "requests")).toBe(7);
	});
});

describe("formatting", () => {
	it("abbreviates large counts and renders an absent value as a dash", () => {
		expect(formatCount(999)).toBe("999");
		expect(formatCount(1500)).toBe("1.5K");
		expect(formatCount(2_400_000)).toBe("2.4M");
		expect(formatCount(null)).toBe("—");
	});

	it("renders CPU time in milliseconds, with a floor for sub-millisecond values", () => {
		expect(formatCpu(6079)).toBe("6.1 ms");
		expect(formatCpu(400)).toBe("<1 ms");
		expect(formatCpu(null)).toBe("—");
	});

	it("gives a worker the same colour regardless of the current filter", () => {
		const all = ["a", "b", "c"];
		expect(workerColor("b", all)).toBe(workerColor("b", all));
		expect(workerColor("a", all)).not.toBe(workerColor("b", all));
	});
});

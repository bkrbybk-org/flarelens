import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { HEADLINE_ACTIONS, bucketDimension, buildAggregates } from "../src/lib/waf-aggregates";
import { graphBuckets, seriesAsTimedEvents } from "../web/src/lib/waf/chart";

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("buildAggregates", () => {
	// Shapes as returned live on 2026-09-28 by firewallEventsAdaptiveGroups.
	const actions = [
		{ count: 5741, avg: { sampleInterval: 4 }, dimensions: { action: "block" } },
		{ count: 3325, avg: { sampleInterval: 10 }, dimensions: { action: "link_maze_injected" } },
		{ count: 1663, avg: { sampleInterval: 4 }, dimensions: { action: "log" } },
		{ count: 347, avg: { sampleInterval: 1 }, dimensions: { action: "skip" } },
		{ count: 26, avg: { sampleInterval: 1 }, dimensions: { action: "managed_challenge" } },
	];

	it("totals only the headline actions but keeps every action's count", () => {
		const agg = buildAggregates(actions, [], [], 1440);
		expect(agg.total).toBe(5741 + 1663 + 26);
		expect(agg.byAction.link_maze_injected).toBe(3325);
		expect(agg.byAction.skip).toBe(347);
		expect(HEADLINE_ACTIONS).not.toContain("skip");
	});

	it("weights the average sample interval by count", () => {
		const agg = buildAggregates([actions[0], actions[4]], [], [], 1440);
		expect(agg.sampleInterval).toBeCloseTo((4 * 5741 + 1 * 26) / (5741 + 26));
	});

	it("folds the series by bucket, in time order, and keeps countries as reported", () => {
		const agg = buildAggregates(
			[],
			[
				{ count: 5, dimensions: { action: "log", datetimeHour: "2026-09-27T02:00:00Z" } },
				{ count: 7, dimensions: { action: "block", datetimeHour: "2026-09-27T01:00:00Z" } },
				{ count: 3, dimensions: { action: "block", datetimeHour: "2026-09-27T02:00:00Z" } },
			],
			[{ count: 573, dimensions: { clientCountryName: "BE" } }, { count: 250, dimensions: { clientCountryName: "US" } }],
			1440,
		);
		expect(agg.series).toEqual([
			{ ts: "2026-09-27T01:00:00Z", byAction: { block: 7 } },
			{ ts: "2026-09-27T02:00:00Z", byAction: { log: 5, block: 3 } },
		]);
		expect(agg.bucket).toBe("1h");
		expect(agg.countries).toEqual([{ country: "BE", count: 573 }, { country: "US", count: 250 }]);
	});

	it("uses 15-minute buckets up to 6 hours, hourly beyond", () => {
		expect(bucketDimension(360)).toBe("datetimeFifteenMinutes");
		expect(bucketDimension(361)).toBe("datetimeHour");
	});
});

describe("the chart draws full counts from the series", () => {
	it("weights each series point by its count and keeps a bucket that starts before the window", () => {
		const start = Date.parse("2026-09-27T01:30:00Z");
		const end = Date.parse("2026-09-27T03:30:00Z");
		const points = seriesAsTimedEvents(
			[
				{ ts: "2026-09-27T01:00:00Z", byAction: { block: 100 } },
				{ ts: "2026-09-27T02:00:00Z", byAction: { block: 40, log: 10 } },
			],
			start,
		);
		const buckets = graphBuckets(points, start, end, 2, { block: true, log: true, managed_challenge: true, js_challenge: true });
		expect(buckets.map((b) => b.total)).toEqual([100, 50]);
		expect(buckets[1].counts).toMatchObject({ block: 40, log: 10 });
	});
});

describe("POST /api/waf/events", () => {
	const call = () =>
		app.request(
			"/api/waf/events",
			{ method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, minutes: 1440 }) },
			ENV,
		);

	it("returns the sampled rows and the full counts together", async () => {
		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (String(body.query).includes("firewallEventsAdaptiveGroups")) {
				const rows = body.query.includes("clientCountryName")
					? [{ count: 9, dimensions: { clientCountryName: "TH" } }]
					: body.query.includes("datetimeHour")
						? [{ count: 9, dimensions: { action: "block", datetimeHour: "2026-09-27T01:00:00Z" } }]
						: [{ count: 9, avg: { sampleInterval: 3 }, dimensions: { action: "block" } }];
				return json({ data: { viewer: { accounts: [{ firewallEventsAdaptiveGroups: rows }] } } });
			}
			return json({ data: { viewer: { accounts: [{ firewallEventsAdaptive: [{ action: "block", ruleId: "r1", rayName: "x", datetime: "2026-09-27T01:10:00Z" }] }] } } });
		}) as typeof fetch;
		const body = (await (await call()).json()) as { result: unknown[]; aggregates: { total: number; countries: unknown[] } };
		expect(body.result).toHaveLength(1);
		expect(body.aggregates.total).toBe(9);
		expect(body.aggregates.countries).toEqual([{ country: "TH", count: 9 }]);
	});

	it("keeps the rows and states why when the full counts fail", async () => {
		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (String(body.query).includes("firewallEventsAdaptiveGroups")) return json({ errors: [{ message: "unknown field" }] });
			return json({ data: { viewer: { accounts: [{ firewallEventsAdaptive: [{ action: "log", ruleId: "r1", rayName: "y" }] }] } } });
		}) as typeof fetch;
		const res = await call();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: unknown[]; aggregates?: unknown; aggregatesError?: string };
		expect(body.result).toHaveLength(1);
		expect(body.aggregates).toBeUndefined();
		expect(body.aggregatesError).toBe("unknown field");
	});
});

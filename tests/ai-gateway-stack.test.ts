import { describe, expect, it } from "vitest";
import { OTHER, THIRD_PARTY, WORKERS_AI, buildStacks, sourceOf, windowBuckets } from "../web/src/features/ai-gateway/stack";
import { granularityFor } from "../web/src/features/ai-gateway/types";
import type { AiGatewaySplitPoint } from "../web/src/features/ai-gateway/types";

/** The AI Gateway stacked chart's data: whole-window buckets, top keys plus Other, Workers AI vs third-party. */

const pt = (ts: string, key: string, requests: number, cost = 0): AiGatewaySplitPoint => ({ ts, key, requests, tokens: null, cost, errors: null });

describe("granularityFor", () => {
	it("uses 15-minute buckets up to 6 hours, hours for a day, days beyond", () => {
		expect(granularityFor(60)).toBe("15m");
		expect(granularityFor(360)).toBe("15m");
		expect(granularityFor(1440)).toBe("hourly");
		expect(granularityFor(10_080)).toBe("daily");
		expect(granularityFor(43_200)).toBe("daily");
	});
});

describe("windowBuckets", () => {
	it("lists every day of the window, spelled as the API spells dates", () => {
		expect(windowBuckets("2026-10-28T13:00:00.000Z", "2026-11-04T13:00:00.000Z", "daily")).toEqual([
			"2026-10-28",
			"2026-10-29",
			"2026-10-30",
			"2026-10-31",
			"2026-11-01",
			"2026-11-02",
			"2026-11-03",
			"2026-11-04",
		]);
	});

	it("lists hours and quarter hours on their boundaries", () => {
		expect(windowBuckets("2026-11-04T10:20:00.000Z", "2026-11-04T12:05:00.000Z", "hourly")).toEqual(["2026-11-04T10:00:00Z", "2026-11-04T11:00:00Z", "2026-11-04T12:00:00Z"]);
		expect(windowBuckets("2026-11-04T10:20:00.000Z", "2026-11-04T11:00:00.000Z", "15m")).toEqual([
			"2026-11-04T10:15:00Z",
			"2026-11-04T10:30:00Z",
			"2026-11-04T10:45:00Z",
			"2026-11-04T11:00:00Z",
		]);
	});

	it("is empty for a nonsense window", () => {
		expect(windowBuckets("x", "y", "daily")).toEqual([]);
	});
});

describe("buildStacks", () => {
	it("keeps days with no traffic as empty buckets instead of closing the gap", () => {
		const s = buildStacks([], [pt("2026-11-01", "prod", 5), pt("2026-11-03", "prod", 2)], "gateway", "requests", ["2026-11-01", "2026-11-02", "2026-11-03"]);
		expect(s.buckets.map((b) => [b.ts, b.total])).toEqual([
			["2026-11-01", 5],
			["2026-11-02", 0],
			["2026-11-03", 2],
		]);
	});

	it("folds Workers AI against every third-party provider", () => {
		expect(sourceOf("workers-ai")).toBe(WORKERS_AI);
		expect(sourceOf("openai")).toBe(THIRD_PARTY);
		const s = buildStacks([], [pt("d1", "workers-ai", 7), pt("d1", "openai", 2), pt("d1", "anthropic", 1)], "source", "requests", ["d1"]);
		expect(s.keys).toEqual([WORKERS_AI, THIRD_PARTY]);
		expect(s.buckets[0].values).toEqual({ [WORKERS_AI]: 7, [THIRD_PARTY]: 3 });
	});

	it("stacks the biggest keys first and folds the long tail into Other", () => {
		const points = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k, i) => pt("d1", k, 100 - i));
		const s = buildStacks([], points, "model", "requests", ["d1"]);
		expect(s.keys).toEqual(["a", "b", "c", "d", "e", "f", OTHER]);
		expect(s.totals[OTHER]).toBe(93 + 94);
		// Seven keys fit without an "Other" of one.
		expect(buildStacks([], points.slice(0, 7), "model", "requests", ["d1"]).keys).not.toContain(OTHER);
	});

	it("stacks the chosen measure", () => {
		const s = buildStacks([], [pt("d1", "a", 10, 0.5), pt("d1", "b", 1, 2)], "model", "cost", ["d1"]);
		expect(s.keys).toEqual(["b", "a"]);
		expect(s.buckets[0].total).toBe(2.5);
	});
});

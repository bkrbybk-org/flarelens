import { describe, expect, it } from "vitest";
import { CHART_ACTIONS } from "../web/src/lib/waf/constants";
import { formatBucketTime } from "../web/src/lib/waf/format";
import {
	eventsWithTime,
	formatPeakBucket,
	graphBucketRange,
	graphBuckets,
	graphBucketTitle,
	peakBucket,
	type TimedEvent,
} from "../web/src/lib/waf/chart";
import type { FirewallEvent } from "../web/src/lib/waf/types";

// All actions on, used as the default toggle map for tests that don't care about filtering.
const ALL_ON = Object.fromEntries(CHART_ACTIONS.map((action) => [action.key, true]));

function ev(action: string, datetime?: string): FirewallEvent {
	return { action, datetime };
}

describe("eventsWithTime", () => {
	it("keeps events with a parseable datetime and attaches a numeric time", () => {
		const [result] = eventsWithTime([ev("block", "2024-01-01T00:00:00.000Z")]);
		expect(result.time).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
	});

	it("drops events with no datetime field", () => {
		expect(eventsWithTime([ev("block")])).toHaveLength(0);
	});

	it("drops events whose datetime doesn't parse to a finite time", () => {
		expect(eventsWithTime([ev("block", "not-a-date")])).toHaveLength(0);
	});
});

describe("graphBuckets — bucketing maths", () => {
	// Window [0, 1000) split into 5 buckets of 200ms each.
	const start = 0;
	const end = 1000;
	const bucketCount = 5;

	function timed(action: string, time: number): TimedEvent {
		return { action, time } as TimedEvent;
	}

	it("produces exactly bucketCount buckets spanning start to end", () => {
		const buckets = graphBuckets([], start, end, bucketCount, ALL_ON);
		expect(buckets).toHaveLength(5);
		expect(buckets[0].start).toBe(0);
		expect(buckets[0].end).toBe(200);
		expect(buckets[4].start).toBe(800);
		expect(buckets[4].end).toBe(1000);
	});

	it("returns all-zero buckets for an empty event list", () => {
		const buckets = graphBuckets([], start, end, bucketCount, ALL_ON);
		for (const bucket of buckets) {
			expect(bucket.total).toBe(0);
			expect(Object.values(bucket.counts).every((n) => n === 0)).toBe(true);
		}
	});

	it("places an event in the bucket matching its offset from start", () => {
		// 450ms falls in the third bucket, [400, 600).
		const buckets = graphBuckets([timed("block", 450)], start, end, bucketCount, ALL_ON);
		expect(buckets[2].counts.block).toBe(1);
		expect(buckets.filter((b) => b.total > 0)).toHaveLength(1);
	});

	it("an event exactly at the window start lands in bucket 0", () => {
		const buckets = graphBuckets([timed("block", 0)], start, end, bucketCount, ALL_ON);
		expect(buckets[0].counts.block).toBe(1);
	});

	it("an event exactly at the window end lands in the last bucket, not off the end", () => {
		// floor((1000-0)/200) === 5, which is out of range for a 5-bucket array;
		// the clamp pulls it back into bucket index 4 instead of throwing/dropping it.
		const buckets = graphBuckets([timed("block", 1000)], start, end, bucketCount, ALL_ON);
		expect(buckets[4].counts.block).toBe(1);
	});

	// Events outside [start, end] are dropped rather than clamped into the edge buckets, so a
	// bucket never reports traffic from outside the window it labels.
	it("excludes an event before the window start", () => {
		const buckets = graphBuckets([timed("block", -500)], start, end, bucketCount, ALL_ON);
		expect(buckets[0].counts.block).toBe(0);
		expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(0);
	});

	it("excludes an event after the window end", () => {
		const buckets = graphBuckets([timed("block", 5000)], start, end, bucketCount, ALL_ON);
		expect(buckets[4].counts.block).toBe(0);
		expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(0);
	});

	it("ignores events whose action doesn't map to any chart action group", () => {
		const buckets = graphBuckets([timed("allow", 450)], start, end, bucketCount, ALL_ON);
		for (const bucket of buckets) {
			expect(bucket.total).toBe(0);
		}
	});

	it("when every action is toggled off, counts are still recorded but totals stay zero", () => {
		const allOff = Object.fromEntries(CHART_ACTIONS.map((action) => [action.key, false]));
		const buckets = graphBuckets([timed("block", 450), timed("log", 450)], start, end, bucketCount, allOff);
		expect(buckets[2].counts.block).toBe(1);
		expect(buckets[2].counts.log).toBe(1);
		expect(buckets[2].total).toBe(0);
	});

	it("bucket total matches the sum of counts for the actions currently toggled on", () => {
		// block on, log off: total should reflect only the block hit even though
		// both actions land in the same bucket.
		const partial = { block: true, managed_challenge: true, js_challenge: true, log: false };
		const buckets = graphBuckets(
			[timed("block", 450), timed("log", 460), timed("challenge", 470)],
			start,
			end,
			bucketCount,
			partial,
		);
		const bucket = buckets[2];
		expect(bucket.counts.block).toBe(1);
		expect(bucket.counts.log).toBe(1);
		expect(bucket.counts.managed_challenge).toBe(1); // "challenge" normalizes into the managed_challenge group
		const expectedTotal = CHART_ACTIONS.filter((a) => partial[a.key]).reduce((sum, a) => sum + bucket.counts[a.key], 0);
		expect(bucket.total).toBe(expectedTotal);
		expect(bucket.total).toBe(2);
	});
});

describe("peakBucket", () => {
	it("picks the bucket with the highest total", () => {
		const buckets = [
			{ total: 1, counts: {}, start: 0, end: 1 },
			{ total: 9, counts: {}, start: 1, end: 2 },
			{ total: 3, counts: {}, start: 2, end: 3 },
		];
		expect(peakBucket(buckets)).toBe(buckets[1]);
	});

	it("falls back to a zeroed bucket rather than throwing on an empty list", () => {
		expect(peakBucket([])).toEqual({ total: 0, counts: {}, start: 0, end: 0 });
	});
});

describe("formatPeakBucket", () => {
	it("reports no activity for a zero-total bucket", () => {
		expect(formatPeakBucket({ total: 0, counts: {}, start: 0, end: 0 })).toBe("No visible activity");
	});

	it("formats the time range and count for an active bucket", () => {
		const bucket = { total: 1234, counts: {}, start: 0, end: 200 };
		const expected = `${formatBucketTime(0)}-${formatBucketTime(200)} / ${(1234).toLocaleString()} events`;
		expect(formatPeakBucket(bucket)).toBe(expected);
	});
});

describe("graphBucketRange", () => {
	it("renders just the start-end time range, no counts", () => {
		const bucket = { total: 5, counts: {}, start: 0, end: 200 };
		expect(graphBucketRange(bucket)).toBe(`${formatBucketTime(0)}-${formatBucketTime(200)}`);
	});
});

describe("graphBucketTitle", () => {
	it("lists every chart action's count, even ones at zero, in CHART_ACTIONS order", () => {
		const counts = Object.fromEntries(CHART_ACTIONS.map((a, i) => [a.key, i]));
		const bucket = { total: 6, counts, start: 0, end: 200 };
		const expectedCounts = CHART_ACTIONS.map((a) => `${a.label}: ${(counts[a.key] || 0).toLocaleString()}`).join(", ");
		expect(graphBucketTitle(bucket)).toBe(`${formatBucketTime(0)}-${formatBucketTime(200)}; ${expectedCounts}`);
	});
});

// Ported from cf-waf-rules-analyzer src/lib/chart.js

import { CHART_ACTIONS } from "./constants";
import { clampNumber, formatBucketTime, normalizeAction } from "./format";
import type { FirewallEvent, WafAggregates } from "./types";

export interface TimedEvent extends FirewallEvent {
	time: number;
	/** How many events this point stands for; 1 for a sampled row, the bucket count for a series point. */
	weight?: number;
}

export interface GraphBucket {
	total: number;
	counts: Record<string, number>;
	start: number;
	end: number;
}

export const chartActionFor = (action: string) => CHART_ACTIONS.find((group) => group.actions.includes(action));

export function eventsWithTime(events: FirewallEvent[]): TimedEvent[] {
	return events
		.filter((event) => event.datetime)
		.map((event) => ({ ...event, time: new Date(event.datetime!).getTime() }))
		.filter((event) => Number.isFinite(event.time));
}

/**
 * The groups dataset's series as weighted points, so the chart has one bucketing path whichever
 * source it draws. Each point sits at the middle of its series bucket: the chart's own buckets start
 * wherever the window starts, rarely on the hour, and a point at the series bucket's start would
 * land one chart bucket early. A point before the window (a partial first bucket) moves to its start.
 */
export function seriesAsTimedEvents(series: WafAggregates["series"], windowStart: number, bucket: WafAggregates["bucket"] = "1h"): TimedEvent[] {
	const half = (bucket === "15m" ? 15 : 60) * 30_000;
	const points: TimedEvent[] = [];
	for (const { ts, byAction } of series) {
		const time = new Date(ts).getTime();
		if (!Number.isFinite(time)) continue;
		for (const [action, count] of Object.entries(byAction)) {
			if (count > 0) points.push({ action, datetime: ts, time: Math.max(time + half, windowStart), weight: count });
		}
	}
	return points;
}

export function graphBuckets(
	events: TimedEvent[],
	start: number,
	end: number,
	bucketCount: number,
	chartActions: Record<string, boolean>,
): GraphBucket[] {
	const bucketMs = (end - start) / bucketCount;
	const buckets: GraphBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
		total: 0,
		counts: Object.fromEntries(CHART_ACTIONS.map((action) => [action.key, 0])),
		start: start + index * bucketMs,
		end: start + (index + 1) * bucketMs,
	}));
	for (const event of events) {
		// Outside the requested window is excluded, not clamped: folding a stray event into the
		// first or last bucket makes that bucket claim traffic the window never contained.
		// `end` itself is kept — the window is inclusive of its own upper bound, and the index
		// it computes is one past the last bucket, so it is clamped down rather than dropped.
		if (event.time < start || event.time > end) continue;
		const index = clampNumber(Math.floor((event.time - start) / bucketMs), 0, bucketCount - 1);
		const group = chartActionFor(normalizeAction(event.action));
		if (!group) continue;
		const weight = event.weight ?? 1;
		buckets[index].counts[group.key] += weight;
		if (chartActions[group.key]) buckets[index].total += weight;
	}
	return buckets;
}

export function peakBucket(buckets: GraphBucket[]): GraphBucket {
	return buckets.reduce((best, bucket) => (bucket.total > best.total ? bucket : best), buckets[0] || { total: 0, counts: {}, start: 0, end: 0 });
}

export function formatPeakBucket(bucket: GraphBucket): string {
	if (!bucket?.total) return "No visible activity";
	return `${formatBucketTime(bucket.start)}-${formatBucketTime(bucket.end)} / ${bucket.total.toLocaleString()} events`;
}

/** Just the time range of a bucket — the tooltip lists the per-action counts as its own rows. */
export function graphBucketRange(bucket: GraphBucket): string {
	return `${formatBucketTime(bucket.start)}-${formatBucketTime(bucket.end)}`;
}

export function graphBucketTitle(bucket: GraphBucket): string {
	const counts = CHART_ACTIONS.map(
		(action) => `${action.label}: ${(bucket.counts[action.key] || 0).toLocaleString()}`,
	).join(", ");
	return `${formatBucketTime(bucket.start)}-${formatBucketTime(bucket.end)}; ${counts}`;
}

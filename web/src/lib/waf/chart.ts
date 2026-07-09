// Ported from cf-waf-rules-analyzer src/lib/chart.js

import { CHART_ACTIONS } from "./constants";
import { clampNumber, formatBucketTime, normalizeAction } from "./format";
import type { FirewallEvent } from "./types";

export interface TimedEvent extends FirewallEvent {
	time: number;
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
		const index = clampNumber(Math.floor((event.time - start) / bucketMs), 0, bucketCount - 1);
		const group = chartActionFor(normalizeAction(event.action));
		if (!group) continue;
		buckets[index].counts[group.key] += 1;
		if (chartActions[group.key]) buckets[index].total += 1;
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

export function graphBucketTitle(bucket: GraphBucket): string {
	const counts = CHART_ACTIONS.map(
		(action) => `${action.label}: ${(bucket.counts[action.key] || 0).toLocaleString()}`,
	).join(", ");
	return `${formatBucketTime(bucket.start)}-${formatBucketTime(bucket.end)}; ${counts}`;
}

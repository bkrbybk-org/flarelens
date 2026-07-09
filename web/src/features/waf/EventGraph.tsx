// Ported from cf-waf-rules-analyzer src/components/EventGraph.jsx

import { useState } from "react";
import {
	CHART_ACTIONS,
	GRAPH_DIMENSIONS,
	HOURLY_GRAPH_THRESHOLD_MINUTES,
	MAX_GRAPH_BUCKETS,
} from "../../lib/waf/constants";
import { eventsWithTime, formatPeakBucket, graphBuckets, graphBucketTitle, peakBucket } from "../../lib/waf/chart";
import { axisTimeLabel } from "../../lib/waf/format";
import type { FirewallEvent } from "../../lib/waf/types";

interface EventGraphProps {
	events: FirewallEvent[];
	window: { since: number; until: number; minutes: number } | null;
}

const CARD_CLS = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

export function EventGraph({ events, window: win }: EventGraphProps) {
	const [chartActions, setChartActions] = useState<Record<string, boolean>>(
		Object.fromEntries(CHART_ACTIONS.map((a) => [a.key, true])),
	);

	const withTime = eventsWithTime(events);
	if (!withTime.length || !win) {
		return (
			<section className={CARD_CLS}>
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">Events over time</h2>
					<span className="text-xs text-zinc-500">No telemetry loaded</span>
				</div>
				<div className="flex h-48 items-center justify-center rounded-md border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
					No events to chart for this scope and lookback.
				</div>
			</section>
		);
	}

	const spanMinutes = win.minutes;
	const bucketCount =
		spanMinutes <= HOURLY_GRAPH_THRESHOLD_MINUTES ? 24 : Math.min(MAX_GRAPH_BUCKETS, Math.ceil(spanMinutes / 1440));
	const buckets = graphBuckets(withTime, win.since, win.until, bucketCount, chartActions);
	const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
	const peak = peakBucket(buckets);
	const { width, height, padding, gap } = GRAPH_DIMENSIONS;
	const barWidth = Math.max(8, (width - padding * 2 - gap * (buckets.length - 1)) / buckets.length);
	const innerHeight = height - padding * 2;
	const activeActions = CHART_ACTIONS.filter((action) => chartActions[action.key]);

	return (
		<section className={CARD_CLS}>
			<div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 className="text-sm font-semibold">Events over time</h2>
					<p className="mt-1 text-xs text-zinc-500">Peak bucket: {formatPeakBucket(peak)}</p>
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					{CHART_ACTIONS.map((action) => {
						const active = chartActions[action.key];
						const cls = active
							? "border-zinc-300 bg-white text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
							: "border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600";
						return (
							<button
								key={action.key}
								type="button"
								className={`inline-flex items-center gap-1.5 rounded-full border ${cls} px-2 py-1 transition-colors`}
								aria-pressed={active}
								title={`Toggle ${action.label}`}
								onClick={() => setChartActions((prev) => ({ ...prev, [action.key]: !prev[action.key] }))}
							>
								<span className={`h-2 w-2 rounded-full ${action.dotClass}`} />
								<span>{action.label}</span>
							</button>
						);
					})}
				</div>
			</div>
			<svg className="h-56 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Firewall events over time">
				<line
					x1={padding} y1={height - padding} x2={width - padding} y2={height - padding}
					className="stroke-zinc-300 dark:stroke-zinc-700"
				/>
				{buckets.map((bucket, index) => {
					const x = padding + index * (barWidth + gap);
					const title = graphBucketTitle(bucket);
					if (!bucket.total) {
						return (
							<rect key={index} x={x} y={height - padding - 1} width={barWidth} height="1" className="fill-zinc-200 dark:fill-zinc-800">
								<title>{title}</title>
							</rect>
						);
					}
					let y = height - padding;
					const segments = [];
					for (const action of activeActions) {
						const count = bucket.counts[action.key] || 0;
						const segHeight = (innerHeight * count) / max;
						if (!segHeight) continue;
						y -= segHeight;
						segments.push(
							<rect key={action.key} x={x} y={y} width={barWidth} height={segHeight} fill={action.color} rx="1">
								<title>{title}</title>
							</rect>,
						);
					}
					return <g key={index}>{segments}</g>;
				})}
				{[0, 0.25, 0.5, 0.75, 1].map((frac) => {
					const x = padding + frac * (width - padding * 2);
					const ts = win.since + frac * (win.until - win.since);
					const anchor = frac === 0 ? "start" : frac === 1 ? "end" : "middle";
					return (
						<text key={frac} x={x} y={height - 6} textAnchor={anchor} fontSize="11" className="fill-zinc-500 dark:fill-zinc-400">
							{axisTimeLabel(ts, spanMinutes)}
						</text>
					);
				})}
				<text x={padding} y="14" fontSize="11" className="fill-zinc-500 dark:fill-zinc-400">
					Visible max bucket: {max.toLocaleString()}
				</text>
			</svg>
		</section>
	);
}

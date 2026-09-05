import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import type { CountItem, DetectionPoint, TimePoint } from "../../lib/ai-sec/types";

/**
 * Charts for the AI Security section, drawn as inline SVG.
 *
 * The section this was ported from used uPlot. Flarelens draws its own SVG (see
 * features/waf/EventGraph.tsx and features/cache/TrendChart.tsx), so these follow that rather
 * than adding a charting dependency the repo does not have — the shapes here are a line, a
 * stack and a bar row, which is well inside what SVG does without help.
 *
 * Colours come from Tailwind's palette via `currentColor` and a wrapper class, so light and
 * dark both work without a second set of values.
 */

export const CARD_CLS = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

const SPARK_W = 100;
const SPARK_H = 24;

/**
 * KPI sparkline. Scaled to its own maximum, not a shared axis: it answers "what shape did this
 * signal have", not "how does it compare to the tile beside it" — a shared scale flattens every
 * small signal into a straight line next to the traffic count.
 */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
	// Two points is the minimum that describes a trend; one bucket is a dot, not a shape.
	if (values.length < 2) return null;
	const max = Math.max(...values);
	const scale = max > 0 ? max : 1;
	const pt = (v: number, i: number) => {
		const x = (i / (values.length - 1)) * SPARK_W;
		// 1px inset so a peak's stroke is not clipped by the viewBox edge.
		const y = SPARK_H - 1 - (v / scale) * (SPARK_H - 2);
		return `${x.toFixed(2)},${y.toFixed(2)}`;
	};
	const line = "M" + values.map(pt).join("L");
	return (
		<svg
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
			preserveAspectRatio="none"
			aria-hidden
			focusable="false"
			className={`h-7 w-full ${className ?? "text-cf"}`}
		>
			<path d={`${line}L${SPARK_W},${SPARK_H}L0,${SPARK_H}Z`} fill="currentColor" opacity={0.14} />
			{/* Non-scaling stroke: the viewBox is stretched to the tile width, so without this the
			    line thins and thickens as the card resizes. */}
			<path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

function axisLabel(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const CHART_W = 720;
const CHART_H = 180;
const PAD_L = 34;
const PAD_B = 18;

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const pow = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / pow) * pow;
}

interface TrendProps {
	title: string;
	series: TimePoint[];
	previous?: TimePoint[];
	/** Text alternative; the SVG is decorative and marked aria-hidden. */
	summary: string;
}

/** Request volume over the window, with an optional dashed previous-period overlay. */
export function TrendChart({ title, series, previous, summary }: TrendProps) {
	// Called before the early return below: hooks must run on every render.
	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: CHART_W,
		viewHeight: CHART_H,
		plotLeft: PAD_L,
		plotRight: CHART_W - 4,
		mode: "point",
	});

	if (series.length < 2) {
		return (
			<section className={CARD_CLS}>
				<h2 className="mb-3 text-sm font-semibold">{title}</h2>
				<p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">Not enough data to chart this window.</p>
			</section>
		);
	}
	const max = niceMax(Math.max(1, ...series.map((p) => p.count), ...(previous ?? []).map((p) => p.count)));
	const x = (i: number) => PAD_L + (i / (series.length - 1)) * (CHART_W - PAD_L - 4);
	const y = (v: number) => (CHART_H - PAD_B) - (v / max) * (CHART_H - PAD_B - 6);
	const path = (points: TimePoint[]) => "M" + points.map((p, i) => `${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join("L");

	const hoveredRows = hover === null
		? []
		: [
			{ label: "Requests", value: series[hover.index].count.toLocaleString(), color: "#f6821f" },
			...(previous?.length === series.length
				? [{ label: "Previous period", value: previous[hover.index].count.toLocaleString(), color: "#a1a1aa" }]
				: []),
		];

	return (
		<section className={CARD_CLS}>
			<div className="mb-3 flex items-baseline justify-between gap-3">
				<h2 className="text-sm font-semibold">{title}</h2>
				{previous?.length ? (
					<span className="text-xs text-zinc-500 dark:text-zinc-400">Dashed: previous period</span>
				) : null}
			</div>
			<div className="relative">
			<svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label={summary} {...hoverProps}>
				<line x1={PAD_L} y1={CHART_H - PAD_B} x2={CHART_W - 4} y2={CHART_H - PAD_B} className="stroke-zinc-200 dark:stroke-zinc-700" strokeWidth={1} />
				<line x1={PAD_L} y1={6} x2={CHART_W - 4} y2={6} className="stroke-zinc-100 dark:stroke-zinc-800" strokeWidth={1} />
				<text x={4} y={12} className="fill-zinc-400 text-[10px]">{max.toLocaleString()}</text>
				<text x={4} y={CHART_H - PAD_B} className="fill-zinc-400 text-[10px]">0</text>
				<text x={PAD_L} y={CHART_H - 4} className="fill-zinc-400 text-[10px]">{axisLabel(series[0].ts)}</text>
				<text x={CHART_W - 4} y={CHART_H - 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
					{axisLabel(series[series.length - 1].ts)}
				</text>
				<path d={`${path(series)}L${x(series.length - 1)},${CHART_H - PAD_B}L${PAD_L},${CHART_H - PAD_B}Z`} className="fill-cf" opacity={0.12} />
				{previous?.length === series.length && (
					<path d={path(previous)} fill="none" className="stroke-zinc-400 dark:stroke-zinc-500" strokeWidth={1.5} strokeDasharray="5 4" />
				)}
				<path d={path(series)} fill="none" className="stroke-cf" strokeWidth={2} />
				{hover !== null && (
					<>
						<HoverGuide x={x(hover.index)} top={6} bottom={CHART_H - PAD_B} />
						<circle cx={x(hover.index)} cy={y(series[hover.index].count)} r={3.5} className="fill-cf" pointerEvents="none" />
					</>
				)}
			</svg>
			<ChartTooltip
				hover={hover}
				header={hover === null ? "" : axisLabel(series[hover.index].ts)}
				rows={hoveredRows}
			/>
			</div>
		</section>
	);
}

/** The four detection types, stacked. Order matters: it is also the legend order. */
const DETECTIONS = [
	{ key: "injection", label: "Prompt injection", cls: "fill-red-500", dot: "bg-red-500" },
	{ key: "pii", label: "PII", cls: "fill-amber-500", dot: "bg-amber-500" },
	{ key: "unsafe", label: "Unsafe topic", cls: "fill-emerald-500", dot: "bg-emerald-500" },
	{ key: "custom", label: "Custom topic", cls: "fill-violet-500", dot: "bg-violet-500" },
] as const;

/** Swatch colours matching the DETECTIONS fill classes; the tooltip is not a Tailwind context. */
const DETECTION_HEX: Record<(typeof DETECTIONS)[number]["key"], string> = {
	injection: "#ef4444",
	pii: "#f59e0b",
	unsafe: "#10b981",
	custom: "#8b5cf6",
};

/**
 * Stacked detections over time.
 *
 * Drawn as stacked columns rather than stacked areas: the buckets are discrete and often
 * mostly empty, and an area chart across a sparse series draws slopes between points that never
 * happened. A column is only ever as wide as its own bucket.
 */
export function DetectionsChart({ series, summary }: { series: DetectionPoint[]; summary: string }) {
	const totals = series.map((p) => p.injection + p.pii + p.unsafe + p.custom);
	const max = niceMax(Math.max(1, ...totals));
	const slot = (CHART_W - PAD_L - 4) / Math.max(1, series.length);
	const barW = Math.max(1, slot * 0.7);

	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: CHART_W,
		viewHeight: CHART_H,
		plotLeft: PAD_L,
		plotRight: CHART_W - 4,
		mode: "slot",
	});

	return (
		<section className={CARD_CLS}>
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
				<h2 className="text-sm font-semibold">Detections over time</h2>
				<div className="flex flex-wrap gap-3">
					{DETECTIONS.map((d) => (
						<span key={d.key} className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
							<span className={`h-2 w-2 rounded-sm ${d.dot}`} aria-hidden />
							{d.label}
						</span>
					))}
				</div>
			</div>
			{totals.every((t) => t === 0) ? (
				<p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No detections in this window.</p>
			) : (
				<div className="relative">
				<svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label={summary} {...hoverProps}>
					<line x1={PAD_L} y1={CHART_H - PAD_B} x2={CHART_W - 4} y2={CHART_H - PAD_B} className="stroke-zinc-200 dark:stroke-zinc-700" strokeWidth={1} />
					<text x={4} y={12} className="fill-zinc-400 text-[10px]">{max.toLocaleString()}</text>
					<text x={4} y={CHART_H - PAD_B} className="fill-zinc-400 text-[10px]">0</text>
					<text x={PAD_L} y={CHART_H - 4} className="fill-zinc-400 text-[10px]">{axisLabel(series[0].ts)}</text>
					<text x={CHART_W - 4} y={CHART_H - 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
						{axisLabel(series[series.length - 1].ts)}
					</text>
					{series.map((p, i) => {
						let cursor = CHART_H - PAD_B;
						return (
							<g key={p.ts}>
								{DETECTIONS.map((d) => {
									const value = p[d.key];
									if (!value) return null;
									const h = (value / max) * (CHART_H - PAD_B - 6);
									cursor -= h;
									return <rect key={d.key} x={PAD_L + i * slot} y={cursor} width={barW} height={h} className={d.cls} />;
								})}
							</g>
						);
					})}
					{hover !== null && (
						<HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={6} bottom={CHART_H - PAD_B} />
					)}
				</svg>
					<ChartTooltip
						hover={hover}
						header={hover === null ? "" : axisLabel(series[hover.index].ts)}
						// Every detection type is listed even at zero: "no PII in this bucket" is a
						// different statement from "PII not measured", and the legend order is the
						// stack order, so a disappearing row would also reshuffle the list.
						rows={hover === null ? [] : DETECTIONS.map((d) => ({
							label: d.label,
							value: series[hover.index][d.key].toLocaleString(),
							color: DETECTION_HEX[d.key],
							muted: series[hover.index][d.key] === 0,
						}))}
						footer={hover === null ? undefined : `Total ${totals[hover.index].toLocaleString()}`}
					/>
				</div>
			)}
		</section>
	);
}

const TONE_BAR: Record<string, string> = {
	critical: "bg-rose-600",
	high: "bg-red-500",
	medium: "bg-amber-500",
	low: "bg-emerald-500",
	unknown: "bg-zinc-400",
};

/**
 * Ranked breakdown as labelled bars.
 *
 * The original rendered these as a two-column grid with a track underneath each row; this is
 * the same idea in Flarelens's card idiom. Counts are right-aligned and tabular so they stay
 * comparable down the column.
 */
export function BarList({ title, items, emptyText }: { title: string; items: CountItem[]; emptyText: string }) {
	const max = Math.max(1, ...items.map((i) => i.count));
	return (
		<section className={CARD_CLS}>
			<h2 className="mb-3 text-sm font-semibold">{title}</h2>
			{!items.length || items.every((i) => i.count === 0) ? (
				<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{emptyText}</p>
			) : (
				<ul className="space-y-2">
					{items.map((item) => (
						<li key={item.key}>
							<div className="flex items-baseline justify-between gap-3 text-sm">
								<span className="min-w-0 truncate" title={item.label}>{item.label}</span>
								<span className="tabular-nums text-zinc-600 dark:text-zinc-300">{item.count.toLocaleString()}</span>
							</div>
							<div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
								<div
									className={`h-full rounded-full ${TONE_BAR[item.tone ?? ""] ?? "bg-cf"}`}
									style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }}
								/>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

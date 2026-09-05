import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { bucketLabel, formatCount, workerColor, type Granularity, type WorkerMetric } from "./types";

export type ChartType = "line" | "bar";

export interface Series {
	worker: string;
	points: number[];
}

interface MetricsChartProps {
	buckets: string[];
	series: Series[];
	allWorkers: string[];
	granularity: Granularity;
	metric: WorkerMetric;
	chartType: ChartType;
}

const WIDTH = 960;
const HEIGHT = 260;
const PAD_LEFT = 54;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 34;

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / magnitude) * magnitude;
}

function tickLabel(value: number, metric: WorkerMetric): string {
	if (metric === "cpu") return `${value.toFixed(value < 10 ? 1 : 0)}`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return String(value);
}

/**
 * Inline SVG rather than a charting library: the app's CSP allows scripts from 'self' only, so
 * the CDN-loaded Chart.js the upstream dashboard uses could not run here even if it were
 * wanted. Same shapes, no third-party script.
 */
export function MetricsChart({ buckets, series, allWorkers, granularity, metric, chartType }: MetricsChartProps) {
	const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
	const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
	const max = niceMax(Math.max(1, ...series.flatMap((s) => s.points)));
	const stepX = buckets.length > 1 ? innerWidth / (buckets.length - 1) : 0;
	const yFor = (value: number) => PAD_TOP + innerHeight - (value / max) * innerHeight;

	// Enough labels to orient without overlapping; the table carries exact figures.
	const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
	const gridLines = [0, 0.25, 0.5, 0.75, 1];

	// Lines carry a value only at each vertex; bars own their whole column.
	const { hover, hoverProps } = useChartHover({
		count: buckets.length,
		viewWidth: WIDTH,
		viewHeight: HEIGHT,
		plotLeft: PAD_LEFT,
		plotRight: chartType === "bar" ? WIDTH - PAD_RIGHT : PAD_LEFT + stepX * (buckets.length - 1),
		mode: chartType === "bar" ? "slot" : "point",
	});


	if (buckets.length === 0 || series.length === 0) {
		return (
			<div className="flex h-[260px] items-center justify-center rounded-xl border border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
				No data in this range
			</div>
		);
	}

	const barGroupWidth = innerWidth / buckets.length;
	const barWidth = Math.max(1, (barGroupWidth * 0.8) / series.length);

	const hoveredX =
		hover === null
			? 0
			: chartType === "bar"
				? PAD_LEFT + barGroupWidth * (hover.index + 0.5)
				: PAD_LEFT + stepX * hover.index;

	const unit = metric === "cpu" ? " ms" : "";
	const tooltipRows =
		hover === null
			? []
			: series
				.map((s) => ({ series: s, value: s.points[hover.index] ?? 0 }))
				.sort((a, b) => b.value - a.value)
				.map(({ series: s, value }) => ({
					label: s.worker,
					// CPU is already in ms and fractional; counts get the compact form.
					value: metric === "cpu" ? `${value.toFixed(1)}${unit}` : formatCount(value),
					color: workerColor(s.worker, allWorkers),
					muted: value === 0,
				}));

	return (
		// The scroller must not also be the tooltip's anchor: `overflow-x-auto` clips vertically
		// too, which cut the readout off against the top of the chart.
		<div className="relative">
			<div className="overflow-x-auto">
			<svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[260px] w-full min-w-[640px]" role="img"
				aria-label={`${metric} over time by worker`} {...hoverProps}>
				{gridLines.map((fraction) => {
					const y = PAD_TOP + innerHeight * fraction;
					return (
						<g key={fraction}>
							<line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
							<text x={PAD_LEFT - 8} y={y + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
								{tickLabel(max * (1 - fraction), metric)}
							</text>
						</g>
					);
				})}

				{buckets.map((bucket, index) =>
					index % labelEvery === 0 ? (
						<text
							key={bucket}
							x={chartType === "bar" ? PAD_LEFT + barGroupWidth * (index + 0.5) : PAD_LEFT + stepX * index}
							y={HEIGHT - 12}
							textAnchor="middle"
							className="fill-zinc-400 text-[10px]"
						>
							{bucketLabel(bucket, granularity)}
						</text>
					) : null,
				)}

				{chartType === "line"
					? series.map((s) => (
						<polyline
							key={s.worker}
							fill="none"
							stroke={workerColor(s.worker, allWorkers)}
							strokeWidth={1.75}
							strokeLinejoin="round"
							points={s.points.map((value, index) => `${PAD_LEFT + stepX * index},${yFor(value)}`).join(" ")}
						/>
					))
					: series.map((s, seriesIndex) =>
						s.points.map((value, index) => {
							const height = Math.max(0, PAD_TOP + innerHeight - yFor(value));
							return (
								<rect
									key={`${s.worker}-${index}`}
									x={PAD_LEFT + barGroupWidth * index + barWidth * seriesIndex + barGroupWidth * 0.1}
									y={yFor(value)}
									width={barWidth}
									height={height}
									fill={workerColor(s.worker, allWorkers)}
								/>
							);
						}),
					)}

				{hover !== null && <HoverGuide x={hoveredX} top={PAD_TOP} bottom={PAD_TOP + innerHeight} />}
				{hover !== null && chartType === "line" &&
					series.map((s) => (
						<circle
							key={`dot-${s.worker}`}
							cx={hoveredX}
							cy={yFor(s.points[hover.index] ?? 0)}
							r={3}
							fill={workerColor(s.worker, allWorkers)}
							pointerEvents="none"
						/>
					))}
			</svg>
			</div>
			<ChartTooltip
				hover={hover}
				header={hover === null ? "" : bucketLabel(buckets[hover.index], granularity)}
				rows={tooltipRows}
			/>
		</div>
	);
}

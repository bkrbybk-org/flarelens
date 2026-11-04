import { EmptyNote } from "../../components/EmptyState";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { FOCUS_RING, MUTED } from "../../lib/ui";
import { OTHER, colorFor, type Split, type Stacks } from "./stack";
import { aiGatewayBucketLabel as bucketLabel, formatCost, type AiGatewayGranularity } from "./types";

/**
 * The AI Gateway usage chart, in the shapes a cost view needs: stacked or grouped columns, lines
 * or stacked areas; per bucket, accumulated over the window, or one column per group; with a
 * budget line whose overage shows in red, and spend on its own axis over a non-spend measure.
 */

export type ChartType = "stacked" | "grouped" | "line" | "area";
/** buckets: per time bucket. accumulated: running totals. none: one column per group. */
export type ChartMode = "buckets" | "accumulated" | "none";

const W = 960;
const H = 220;
const PAD_L = 56;
const PAD_T = 12;
const PAD_B = 26;
const SPEND_COLOR = "#d97706";
const BUDGET_COLOR = "#dc2626";

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / magnitude) * magnitude;
}

function axisLabel(ts: string, granularity: AiGatewayGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function UsageChart({
	stacks,
	split,
	granularity,
	measure,
	format,
	chartType,
	mode,
	label = (key) => key,
	onPick,
	spendLine,
	budget,
}: {
	stacks: Stacks;
	split: Split;
	granularity: AiGatewayGranularity;
	/** What is charted, for labels: "Requests", "Spend"… */
	measure: string;
	format: (value: number) => string;
	chartType: ChartType;
	mode: ChartMode;
	label?: (key: string) => string;
	onPick?: (key: string) => void;
	/** Spend per bucket, keyed like the buckets, on its own right-hand axis. Bucket mode only. */
	spendLine?: Map<string, number>;
	/** The budget level in the charted unit: per bucket, or for the window when accumulated. */
	budget?: number | null;
}) {
	const { keys } = stacks;
	// "None": one column per group, the window's totals.
	const columns =
		mode === "none"
			? (split === "none" ? ["All"] : keys).map((key) => ({ ts: key, values: { [key]: stacks.totals[key] ?? 0 }, total: stacks.totals[key] ?? 0 }))
			: stacks.buckets;
	const seriesKeys = mode === "none" ? columns.map((c) => c.ts) : keys;
	const type: ChartType = mode === "none" ? "stacked" : chartType;
	const innerH = H - PAD_T - PAD_B;
	const showSpend = Boolean(spendLine) && mode === "buckets";
	const padR = showSpend ? 56 : 12;
	const plotRight = W - padR;
	const slot = (plotRight - PAD_L) / Math.max(1, columns.length);
	const barW = Math.max(1, slot * 0.72);
	const individual = columns.flatMap((c) => Object.values(c.values));
	const peak = type === "stacked" || type === "area" ? Math.max(0, ...columns.map((c) => c.total)) : Math.max(0, ...individual);
	const ceiling = Math.max(peak, budget ?? 0);
	const max = ceiling > 0 && ceiling < 1 ? ceiling * 1.1 : niceMax(Math.max(1e-9, ceiling));
	const y = (v: number) => PAD_T + innerH - (v / max) * innerH;
	const color = (key: string) => (mode === "none" && split === "none" ? "#f6821f" : colorFor(key, seriesKeys.indexOf(key), split));
	const spendValues = showSpend ? columns.map((c) => spendLine!.get(c.ts) ?? 0) : [];
	const spendMax = Math.max(0, ...spendValues) || 1;
	const labelEvery = Math.max(1, Math.ceil(columns.length / 8));
	const xMid = (i: number) => PAD_L + i * slot + barW / 2;

	const { hover, hoverProps } = useChartHover({ count: columns.length, viewWidth: W, viewHeight: H, plotLeft: PAD_L, plotRight, mode: "slot" });

	if (!columns.length || peak === 0) return <EmptyNote title={`No ${measure.toLowerCase()} in this window`} />;
	const column = hover === null ? null : columns[hover.index];

	return (
		<div>
			<div className="relative">
				<svg viewBox={`0 0 ${W} ${H}`} className="h-[240px] w-full" role="img" aria-label={`${measure}${mode === "accumulated" ? ", accumulated" : mode === "none" ? " by group" : ""}`} {...hoverProps}>
					{[0, 0.5, 1].map((fraction) => {
						const ly = PAD_T + innerH * fraction;
						return (
							<g key={fraction}>
								<line x1={PAD_L} x2={plotRight} y1={ly} y2={ly} className="stroke-zinc-200 dark:stroke-zinc-800" />
								<text x={PAD_L - 8} y={ly + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
									{format(max * (1 - fraction))}
								</text>
								{showSpend && (
									<text x={plotRight + 8} y={ly + 4} textAnchor="start" className="fill-amber-500 text-[10px]">
										{formatCost(spendMax * (1 - fraction))}
									</text>
								)}
							</g>
						);
					})}

					{(type === "stacked" || type === "grouped") &&
						columns.map((c, i) => {
							let top = PAD_T + innerH;
							const present = seriesKeys.filter((key) => (c.values[key] ?? 0) > 0);
							const subW = type === "grouped" ? barW / Math.max(1, seriesKeys.length) : barW;
							return (
								<g key={c.ts}>
									{seriesKeys.map((key, k) => {
										const v = c.values[key] ?? 0;
										const h = (v / max) * innerH;
										if (h <= 0) return null;
										if (type === "grouped") {
											return <rect key={key} x={PAD_L + i * slot + k * subW} y={PAD_T + innerH - h} width={Math.max(1, subW - 1)} height={h} fill={color(key)} />;
										}
										top -= h;
										return <rect key={key} x={PAD_L + i * slot} y={top} width={barW} height={h} fill={color(key)} />;
									})}
									{/* Overage: the part of a column above the budget, in red. */}
									{budget && type === "stacked" && c.total > budget && present.length > 0 && (
										<rect x={PAD_L + i * slot} y={y(c.total)} width={barW} height={y(budget) - y(c.total)} fill={BUDGET_COLOR} opacity={0.85} />
									)}
								</g>
							);
						})}

					{type === "line" &&
						seriesKeys.map((key) => (
							<polyline
								key={key}
								fill="none"
								stroke={color(key)}
								strokeWidth={2}
								strokeLinejoin="round"
								points={columns.map((c, i) => `${xMid(i)},${y(c.values[key] ?? 0)}`).join(" ")}
							/>
						))}

					{type === "area" &&
						(() => {
							// Stacked areas, drawn bottom key first: each band between its base and base + value.
							const base = columns.map(() => 0);
							return seriesKeys.map((key) => {
								const lower = base.slice();
								columns.forEach((c, i) => (base[i] += c.values[key] ?? 0));
								const upper = base.slice();
								const points = [
									...upper.map((v, i) => `${xMid(i)},${y(v)}`),
									...lower.map((v, i) => `${xMid(i)},${y(v)}`).reverse(),
								].join(" ");
								return <polygon key={key} points={points} fill={color(key)} fillOpacity={0.75} stroke={color(key)} strokeWidth={1} />;
							});
						})()}

					{budget ? (
						<g>
							<line x1={PAD_L} x2={plotRight} y1={y(budget)} y2={y(budget)} stroke={BUDGET_COLOR} strokeWidth={1.5} strokeDasharray="6 4" />
							<text x={plotRight - 4} y={y(budget) - 4} textAnchor="end" className="fill-red-500 text-[10px]">
								Budget {formatCost(budget)}
							</text>
						</g>
					) : null}

					{showSpend && (
						<polyline
							fill="none"
							stroke={SPEND_COLOR}
							strokeWidth={2}
							strokeLinejoin="round"
							points={spendValues.map((v, i) => `${xMid(i)},${PAD_T + innerH - (v / spendMax) * innerH}`).join(" ")}
						/>
					)}

					{columns.map((c, i) =>
						i % labelEvery === 0 ? (
							<text key={c.ts} x={xMid(i)} y={H - 8} textAnchor="middle" className="fill-zinc-400 text-[10px]">
								{mode === "none" ? label(c.ts).slice(0, 18) : axisLabel(c.ts, granularity)}
							</text>
						) : null,
					)}
					{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
				</svg>
				<ChartTooltip
					hover={hover}
					header={column ? (mode === "none" ? label(column.ts) : bucketLabel(column.ts, granularity) + (mode === "accumulated" ? " (to date)" : "")) : ""}
					rows={
						column
							? [
									...seriesKeys
										.filter((key) => column.values[key])
										.map((key) => ({ label: split === "none" || mode === "none" ? measure : label(key), value: format(column.values[key]), color: color(key) })),
									...(split !== "none" && mode !== "none" ? [{ label: "Total", value: format(column.total) }] : []),
									...(budget ? [{ label: column.total > budget ? "Over budget by" : "Budget", value: format(column.total > budget ? column.total - budget : budget), color: BUDGET_COLOR }] : []),
									...(showSpend ? [{ label: "Spend", value: formatCost(spendLine!.get(column.ts) ?? 0), color: SPEND_COLOR }] : []),
								]
							: []
					}
				/>
			</div>
			{(split !== "none" || showSpend || budget) && (
				<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
					{/* A group with none of the charted measure (a free provider, when charting spend) has nothing to name. */}
					{(split === "none" ? [] : keys.filter((key) => (stacks.totals[key] ?? 0) > 0)).map((key) => {
						const drillable = onPick && key !== OTHER;
						const content = (
							<>
								<span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorFor(key, keys.indexOf(key), split) }} />
								<span className="max-w-[16rem] truncate">{label(key)}</span>
								<span className={`tabular-nums ${MUTED}`}>{format(stacks.totals[key] ?? 0)}</span>
							</>
						);
						return (
							<li key={key}>
								{drillable ? (
									<button type="button" onClick={() => onPick(key)} className={`flex items-center gap-1.5 hover:underline ${FOCUS_RING}`} title={`Drill into ${label(key)}`}>
										{content}
									</button>
								) : (
									<span className="flex items-center gap-1.5">{content}</span>
								)}
							</li>
						);
					})}
					{showSpend && (
						<li className="flex items-center gap-1.5">
							<span aria-hidden className="inline-block h-0.5 w-4" style={{ background: SPEND_COLOR }} />
							Spend (right axis)
							<span className={`tabular-nums ${MUTED}`}>{formatCost(spendValues.reduce((a, b) => a + b, 0))}</span>
						</li>
					)}
					{budget ? (
						<li className="flex items-center gap-1.5">
							<span aria-hidden className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: BUDGET_COLOR }} />
							Budget{mode === "accumulated" ? " for the window" : " per bucket"} {formatCost(budget)}
							<span aria-hidden className="ml-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BUDGET_COLOR }} />
							Overage
						</li>
					) : null}
				</ul>
			)}
		</div>
	);
}

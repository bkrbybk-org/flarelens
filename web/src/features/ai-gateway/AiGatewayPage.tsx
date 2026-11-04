import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { ALERT_ERROR, BADGE, BADGE_NEUTRAL, CARD, FOCUS_RING, MUTED, SECTION_TITLE } from "../../lib/ui";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { getHashParams, setHashParam } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import { TIME_PRESETS, type TimeRange } from "../../hooks/useTimeRange";
import { OTHER, buildStacks, colorFor, windowBuckets, type Split, type Stacks, type StackMetric } from "./stack";
import { useAiGatewayUsage } from "./useAiGatewayUsage";
import { buildInsights } from "./insights";
import {
	EMPTY_TOTALS,
	FILTER_ORDER,
	GRANULARITY_LABEL,
	granularityFor,
	aiGatewayBucketLabel as bucketLabel,
	change,
	compactCount as compact,
	formatCost,
	formatDuration,
	formatRate,
	type AiGatewayBreakdownRow as BreakdownRow,
	type AiGatewayDatasetStatus as DatasetStatus,
	type AiGatewayFilter,
	type AiGatewayGranularity,
	type AiGatewayRequestRow,
	type AiGatewayStatusRow,
} from "./types";

const ACCENT = "#f6821f";

const W = 960;
const H = 200;
const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 26;

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / magnitude) * magnitude;
}

type Metric = StackMetric;
const SPLIT_LABEL: Record<Split, string> = { none: "Total", gateway: "Gateway", model: "Model", source: "Workers AI vs third-party" };
/** In running text: "split by gateway", but "Workers AI" keeps its capitals. */
const splitPhrase = (split: Split) => (split === "source" ? SPLIT_LABEL.source : SPLIT_LABEL[split].toLowerCase());
const METRICS: { id: Metric; label: string; format: (v: number) => string }[] = [
	{ id: "requests", label: "Requests", format: (v) => compact(v) },
	{ id: "tokens", label: "Tokens", format: (v) => compact(v) },
	{ id: "cost", label: "Spend", format: (v) => formatCost(v) },
	{ id: "errors", label: "Errors", format: (v) => compact(v) },
];

/** Bucket axis labels, thinned so they never collide: at most about eight across the chart. */
function axisLabel(ts: string, granularity: AiGatewayGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function StackedChart({ stacks, split, granularity, metric, onPick }: { stacks: Stacks; split: Split; granularity: AiGatewayGranularity; metric: Metric; onPick?: (key: string) => void }) {
	const spec = METRICS.find((m) => m.id === metric)!;
	const { buckets, keys } = stacks;
	const innerH = H - PAD_T - PAD_B;
	const slot = (W - PAD_L - PAD_R) / Math.max(1, buckets.length);
	const barW = Math.max(1, slot * 0.72);
	const peak = Math.max(0, ...buckets.map((b) => b.total));
	const max = metric === "cost" ? peak || 1 : niceMax(Math.max(1, peak));
	const color = (key: string) => colorFor(key, keys.indexOf(key), split);
	const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

	const { hover, hoverProps } = useChartHover({
		count: buckets.length,
		viewWidth: W,
		viewHeight: H,
		plotLeft: PAD_L,
		plotRight: W - PAD_R,
		mode: "slot",
	});

	if (!buckets.length || peak === 0) return <EmptyNote title={`No ${spec.label.toLowerCase()} in this window`} />;
	const bucket = hover === null ? null : buckets[hover.index];

	return (
		<div>
			<div className="relative">
				<svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full" role="img" aria-label={`${spec.label} per ${GRANULARITY_LABEL[granularity].toLowerCase()} bucket${split === "none" ? "" : `, split by ${splitPhrase(split)}`}`} {...hoverProps}>
					{[0, 0.5, 1].map((fraction) => {
						const y = PAD_T + innerH * fraction;
						return (
							<g key={fraction}>
								<line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="stroke-zinc-200 dark:stroke-zinc-800" />
								<text x={PAD_L - 8} y={y + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
									{spec.format(max * (1 - fraction))}
								</text>
							</g>
						);
					})}
					{buckets.map((b, i) => {
						let y = PAD_T + innerH;
						return (
							<g key={b.ts}>
								{keys.map((key) => {
									const h = ((b.values[key] ?? 0) / max) * innerH;
									if (h <= 0) return null;
									y -= h;
									return <rect key={key} x={PAD_L + i * slot} y={y} width={barW} height={h} fill={color(key)} />;
								})}
								{i % labelEvery === 0 && (
									<text x={PAD_L + i * slot + barW / 2} y={H - 8} textAnchor="middle" className="fill-zinc-400 text-[10px]">
										{axisLabel(b.ts, granularity)}
									</text>
								)}
							</g>
						);
					})}
					{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
				</svg>
				<ChartTooltip
					hover={hover}
					header={bucket ? bucketLabel(bucket.ts, granularity) : ""}
					rows={
						bucket
							? [
									...keys
										.filter((key) => bucket.values[key])
										.map((key) => ({ label: split === "none" ? spec.label : key, value: spec.format(bucket.values[key]), color: color(key) })),
									...(split !== "none" ? [{ label: "Total", value: spec.format(bucket.total) }] : []),
								]
							: []
					}
				/>
			</div>
			{split !== "none" && (
				<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
					{keys.map((key) => {
						const drillable = onPick && key !== OTHER;
						const content = (
							<>
								<span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color(key) }} />
								<span className="max-w-[16rem] truncate">{key}</span>
								<span className={`tabular-nums ${MUTED}`}>{spec.format(stacks.totals[key] ?? 0)}</span>
							</>
						);
						return (
							<li key={key}>
								{drillable ? (
									<button type="button" onClick={() => onPick(key)} className={`flex items-center gap-1.5 hover:underline ${FOCUS_RING}`} title={`Drill into ${key}`}>
										{content}
									</button>
								) : (
									<span className="flex items-center gap-1.5">{content}</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/**
 * The change since the previous window, coloured by whether up is good. Requests, tokens and
 * spend have no good direction — more may be the point — so they stay neutral.
 */
function Delta({ value, upIs }: { value: number | null; upIs?: "good" | "bad" }) {
	if (value === null) return <span>no earlier data to compare</span>;
	if (Math.abs(value) < 0.005) return <span>unchanged</span>;
	const up = value > 0;
	// Past doubling, a multiple reads better than "▲ 1,240%".
	const amount = value >= 1 ? `${(value + 1).toFixed(value >= 9 ? 0 : 1)}×` : `${Math.round(Math.abs(value) * 100)}%`;
	const tone = !upIs ? "" : (up ? upIs === "good" : upIs === "bad") ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
	return (
		<span className={tone}>
			{up ? "▲" : "▼"} {amount}
		</span>
	);
}

/** Percentage-point change for a rate, which reads better than a percentage of a percentage. */
function RateDelta({ current, previous, upIs }: { current: number | null; previous: number | null | undefined; upIs: "good" | "bad" }) {
	if (current === null || previous === null || previous === undefined) return <span>no earlier data to compare</span>;
	const points = (current - previous) * 100;
	if (Math.abs(points) < 0.05) return <span>unchanged</span>;
	const good = points > 0 ? upIs === "good" : upIs === "bad";
	return (
		<span className={good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
			{points > 0 ? "▲" : "▼"} {Math.abs(points).toFixed(1)} pts
		</span>
	);
}

/**
 * A panel whose backing dataset failed says so instead of rendering a number that looks like
 * real, quiet data. Distinguishing "unavailable" from "zero" is the whole point.
 */
function UnavailableNote({ status, label }: { status: DatasetStatus; label: string }) {
	if (status.available) return null;
	return (
		<p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
			{label} unavailable{status.reason ? `: ${status.reason}` : ""}.
		</p>
	);
}

type Dimension = "gateway" | "provider" | "model";
type BreakdownTab = Dimension | "status";
const TAB_LABEL: Record<BreakdownTab, string> = { gateway: "Gateways", provider: "Providers", model: "Models", status: "Status codes" };

function BreakdownTable({ rows, total, onDrill, dimension }: { rows: BreakdownRow[]; total: number; onDrill: (key: string) => void; dimension: Dimension }) {
	if (!rows.length) return <p className={`py-6 text-center text-sm ${MUTED}`}>No traffic in this slice.</p>;
	const max = Math.max(1, ...rows.map((r) => r.requests));
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[760px] text-sm">
				<thead className={`text-left text-xs uppercase tracking-wide ${MUTED}`}>
					<tr>
						<th className="py-2 pr-2 font-medium">{TAB_LABEL[dimension].replace(/s$/, "")}</th>
						<th className="px-2 py-2 font-medium">Requests</th>
						<th className="px-2 py-2 text-right font-medium">Tokens in / out</th>
						<th className="px-2 py-2 text-right font-medium">Spend</th>
						<th className="px-2 py-2 text-right font-medium">Errors</th>
						<th className="px-2 py-2 text-right font-medium">Cache</th>
						<th className="px-2 py-2 text-right font-medium">p50 / p95</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key} className="border-t border-zinc-100 dark:border-zinc-800/60">
							<td className="max-w-[18rem] py-2 pr-2">
								<button
									type="button"
									onClick={() => onDrill(row.key)}
									className={`max-w-full truncate text-left font-medium text-cf hover:underline ${FOCUS_RING}`}
									title={`Drill into ${row.key}`}
								>
									{row.key}
								</button>
							</td>
							<td className="w-48 px-2 py-2">
								<div className="flex items-center gap-2">
									<span className="w-12 shrink-0 tabular-nums">{compact(row.requests)}</span>
									<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
										<div className="h-full" style={{ width: `${(row.requests / max) * 100}%`, background: ACCENT }} />
									</div>
									<span className={`w-10 shrink-0 text-right text-xs ${MUTED}`}>{total ? `${Math.round((row.requests / total) * 100)}%` : ""}</span>
								</div>
							</td>
							<td className="px-2 py-2 text-right tabular-nums">
								{compact(row.tokensIn)} / {compact(row.tokensOut)}
							</td>
							<td className="px-2 py-2 text-right tabular-nums">{formatCost(row.cost)}</td>
							<td className={`px-2 py-2 text-right tabular-nums ${row.errors ? "text-red-600 dark:text-red-400" : ""}`}>
								{row.errors === null ? "—" : `${compact(row.errors)} (${formatRate(row.requests ? row.errors / row.requests : null)})`}
							</td>
							<td className="px-2 py-2 text-right tabular-nums">{row.cached === null ? "—" : formatRate(row.requests ? row.cached / row.requests : null)}</td>
							<td className="px-2 py-2 text-right tabular-nums">
								{formatDuration(row.p50)} / {formatDuration(row.p95)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function StatusTable({ rows, total }: { rows: AiGatewayStatusRow[]; total: number }) {
	if (!rows.length) return <p className={`py-6 text-center text-sm ${MUTED}`}>This account's schema reports no status codes.</p>;
	return (
		<ul className="space-y-2 py-2">
			{rows.map((row) => {
				const code = Number(row.statusCode);
				const tone = code >= 500 ? "bg-red-500/15 text-red-600 dark:text-red-400" : code >= 400 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
				return (
					<li key={`${row.statusCode}-${row.rateLimited}`} className="flex items-center gap-3 text-sm">
						<span className={`${BADGE} w-14 text-center ${tone}`}>{row.statusCode}</span>
						{row.rateLimited && <span className={BADGE_NEUTRAL}>rate limited</span>}
						<span className="tabular-nums">{compact(row.requests)}</span>
						<span className={`text-xs ${MUTED}`}>{total ? `${((row.requests / total) * 100).toFixed(1)}%` : ""}</span>
					</li>
				);
			})}
		</ul>
	);
}

function RecentRequests({ rows, onDrill }: { rows: AiGatewayRequestRow[]; onDrill: (key: Dimension, value: string) => void }) {
	const [open, setOpen] = useState<string | null>(null);
	if (!rows.length) return <p className={`py-6 text-center text-sm ${MUTED}`}>No requests in this slice, or the schema carries no request id.</p>;
	return (
		<div className="max-h-[28rem] overflow-auto">
			<table className="w-full min-w-[820px] text-xs">
				<thead className={`sticky top-0 bg-white text-left uppercase tracking-wide dark:bg-zinc-900 ${MUTED}`}>
					<tr>
						{["Time", "Gateway", "Model", "Status", "Duration", "Tokens in / out", "Spend", ""].map((h) => (
							<th key={h} className="px-2 py-2 font-medium">{h}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const code = Number(row.statusCode);
						const expanded = open === row.requestId;
						return (
							<Fragment key={row.requestId}>
								<tr className="border-t border-zinc-100 dark:border-zinc-800/60">
									<td className="whitespace-nowrap px-2 py-1.5">{new Date(row.datetime).toLocaleString()}</td>
									<td className="max-w-[10rem] truncate px-2 py-1.5">
										<button type="button" className={`text-cf hover:underline ${FOCUS_RING}`} onClick={() => onDrill("gateway", row.gateway)}>
											{row.gateway}
										</button>
									</td>
									<td className="max-w-[16rem] truncate px-2 py-1.5" title={row.model}>
										<button type="button" className={`text-cf hover:underline ${FOCUS_RING}`} onClick={() => onDrill("model", row.model)}>
											{row.model}
										</button>
									</td>
									<td className={`px-2 py-1.5 ${code >= 400 ? "text-red-600 dark:text-red-400" : ""}`}>
										{row.statusCode}
										{row.rateLimited && " · rate limited"}
										{row.cached && " · cached"}
									</td>
									<td className="px-2 py-1.5 tabular-nums">{formatDuration(row.durationMs)}</td>
									<td className="px-2 py-1.5 tabular-nums">
										{compact(row.tokensIn)} / {compact(row.tokensOut)}
									</td>
									<td className="px-2 py-1.5 tabular-nums">{formatCost(row.cost)}</td>
									<td className="px-2 py-1.5">
										<button
											type="button"
											aria-expanded={expanded}
											className={`text-cf hover:underline ${FOCUS_RING}`}
											onClick={() => setOpen(expanded ? null : row.requestId)}
										>
											{expanded ? "Hide" : "Details"}
										</button>
									</td>
								</tr>
								{expanded && (
									<tr className="bg-zinc-50 dark:bg-zinc-950/40">
										<td colSpan={8} className="px-4 py-2">
											<dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
												<dt className={MUTED}>Request id</dt>
												<dd className="select-all font-mono">{row.requestId}</dd>
												<dt className={MUTED}>Provider</dt>
												<dd>
													<button type="button" className={`text-cf hover:underline ${FOCUS_RING}`} onClick={() => onDrill("provider", row.provider)}>
														{row.provider || "—"}
													</button>
												</dd>
												<dt className={MUTED}>Client</dt>
												<dd className="break-all">{row.userAgent || "—"}</dd>
												<dt className={MUTED}>Cache</dt>
												<dd>{row.cached ? "served from the Gateway cache" : "not cached"}</dd>
												<dt className={MUTED}>Rate limited</dt>
												<dd>{row.rateLimited ? "yes" : "no"}</dd>
											</dl>
											<p className={`mt-2 ${MUTED}`}>
												Prompt and response bodies live in the gateway's logs in the Cloudflare dashboard; this view reads analytics only.
											</p>
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function readFilter(): AiGatewayFilter {
	const params = getHashParams();
	const filter: AiGatewayFilter = {};
	for (const key of FILTER_ORDER) {
		const value = params.get(key);
		if (value) filter[key] = value;
	}
	return filter;
}

export function AiGatewayPage({
	session,
	timeRange,
	onAuthError,
}: {
	session: Session;
	timeRange: TimeRange;
	onAuthError: () => void;
}) {
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useAiGatewayUsage(onAuthError);
	useSectionRefresh(useCallback(() => setReloadKey((k) => k + 1), []), loading);

	// The slice drilled into: #/ai-gateway?gateway=…&provider=…&model=… — shareable, and kept
	// across reloads. Read once on arrival (the page remounts on each visit to the route).
	const [filter, setFilter] = useState<AiGatewayFilter>(readFilter);
	const [metric, setMetric] = useState<Metric>("requests");
	const [split, setSplit] = useState<Split>("source");
	const [tab, setTab] = useState<BreakdownTab | null>(null);

	const granularity: AiGatewayGranularity = granularityFor(timeRange.minutes);
	const { from, to } = timeRange.bounds();
	const filterKey = FILTER_ORDER.map((k) => filter[k] ?? "").join("\u0000");

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity, filter);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load, filterKey]);

	const applyFilter = (next: AiGatewayFilter) => {
		setFilter(next);
		for (const key of FILTER_ORDER) setHashParam(key, next[key] ?? null);
	};
	const drill = (key: Dimension, value: string) => {
		if (!value || value === "(unknown)") return;
		applyFilter({ ...filter, [key]: value });
		setTab(null);
		// Splitting by the dimension just pinned would leave a single bar.
		if (split === key) setSplit("source");
	};

	const totals = result?.totals ?? EMPTY_TOTALS;
	const previous = result?.previous ?? null;
	const datasets = result?.datasets;
	const tokens = totals.tokensIn === null && totals.tokensOut === null ? null : (totals.tokensIn ?? 0) + (totals.tokensOut ?? 0);
	const insights = useMemo(() => (result ? buildInsights(result) : []), [result]);
	const shownGranularity = result?.granularity ?? granularity;
	const stacks = useMemo(() => {
		const points = split === "gateway" ? result?.seriesBy?.gateway : split === "model" ? result?.seriesBy?.model : split === "source" ? result?.seriesBy?.provider : [];
		return buildStacks(result?.series ?? [], points ?? [], split, metric, windowBuckets(from, to, shownGranularity));
		// from/to move with the clock; the window they describe is keyed by the range and the result.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [result, split, metric, shownGranularity, timeRange.minutes]);

	// Tabs for the dimensions not already pinned by the filter — a drilled-in dimension has one row.
	const tabs: BreakdownTab[] = [...(["gateway", "provider", "model"] as Dimension[]).filter((d) => !filter[d]), "status"];
	const activeTab: BreakdownTab = tab && tabs.includes(tab) ? tab : tabs[0];
	const rowsFor: Record<Dimension, BreakdownRow[]> = {
		gateway: result?.byGateway ?? [],
		provider: result?.byProvider ?? [],
		model: result?.byModel ?? [],
	};
	const prevLabel = result?.previousWindow
		? `vs ${new Date(result.previousWindow.since).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(result.previousWindow.until).toLocaleDateString([], { month: "short", day: "numeric" })}`
		: "";
	const pinned = FILTER_ORDER.filter((k) => filter[k]);

	return (
		<PageShell progress={progress}>
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800" role="group" aria-label="Timeframe">
					{TIME_PRESETS.map((preset) => (
						<button
							key={preset.key}
							type="button"
							aria-pressed={timeRange.preset === preset.key}
							onClick={() => timeRange.setPreset(preset.key)}
							className={`rounded-md px-2.5 py-1 text-xs ${timeRange.preset === preset.key ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"} ${FOCUS_RING}`}
						>
							{preset.label.replace("Last ", "")}
						</button>
					))}
				</div>
				<span className={`text-xs ${MUTED}`}>{GRANULARITY_LABEL[shownGranularity]} buckets</span>
			</div>

			<nav aria-label="AI Gateway slice" className="flex flex-wrap items-center gap-2 text-sm">
				<button
					type="button"
					onClick={() => applyFilter({})}
					className={`rounded-full px-3 py-1 ${pinned.length ? "text-cf hover:underline" : "bg-zinc-200 font-medium dark:bg-zinc-800"} ${FOCUS_RING}`}
					aria-current={pinned.length ? undefined : "page"}
				>
					All AI Gateway traffic
				</button>
				{pinned.map((key, i) => {
					const last = i === pinned.length - 1;
					return (
						<Fragment key={key}>
							<span className={MUTED}>›</span>
							<span className={`flex items-center gap-1 rounded-full px-3 py-1 ${last ? "bg-zinc-200 font-medium dark:bg-zinc-800" : ""}`}>
								<span className={`text-xs ${MUTED}`}>{key}</span>
								<span className="max-w-[20rem] truncate">{filter[key]}</span>
								<button
									type="button"
									aria-label={`Remove ${key} filter`}
									className={`ml-1 rounded px-1 ${MUTED} hover:text-zinc-900 dark:hover:text-zinc-100 ${FOCUS_RING}`}
									onClick={() => {
										const next = { ...filter };
										delete next[key];
										applyFilter(next);
									}}
								>
									×
								</button>
							</span>
						</Fragment>
					);
				})}
				<span className={`ml-auto text-xs ${MUTED}`}>
					{prevLabel ? `Changes ${prevLabel}` : ""}
				</span>
			</nav>

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			<StatGrid cols={3}>
				<StatCard label="Requests" value={compact(totals.requests)} hint={<Delta value={change(totals.requests, previous?.requests)} />} />
				<StatCard
					label="Tokens"
					value={compact(tokens)}
					hint={
						<>
							{compact(totals.tokensIn)} in / {compact(totals.tokensOut)} out · <Delta value={change(tokens, previous?.tokens)} />
						</>
					}
				/>
				<div>
					<StatCard
						label="Spend"
						value={formatCost(totals.cost)}
						hint={
							<>
								{totals.cost !== null && totals.requests ? `${formatCost(totals.cost / totals.requests)} per request · ` : ""}
								<Delta value={change(totals.cost, previous?.cost)} />
							</>
						}
					/>
					{datasets && <UnavailableNote status={datasets.spend} label="Spend" />}
				</div>
				<div>
					<StatCard
						label="Error rate"
						value={formatRate(totals.errorRate)}
						tone={totals.errorRate ? "text-red-600 dark:text-red-400" : undefined}
						hint={
							<>
								{totals.errors !== null ? `${compact(totals.errors)} ${totals.errors === 1 ? "error" : "errors"}` : ""}
								{totals.rateLimited ? ` · ${compact(totals.rateLimited)} rate limited` : ""} ·{" "}
								<RateDelta current={totals.errorRate} previous={previous?.errorRate} upIs="bad" />
							</>
						}
					/>
					{datasets && <UnavailableNote status={datasets.errors} label="Errors" />}
				</div>
				<div>
					<StatCard
						label="Cache hit rate"
						value={formatRate(totals.cacheHitRate)}
						hint={<RateDelta current={totals.cacheHitRate} previous={previous?.cacheHitRate} upIs="good" />}
					/>
					{datasets && <UnavailableNote status={datasets.cache} label="Cache" />}
				</div>
				<StatCard
					label="Latency p50"
					value={formatDuration(totals.p50)}
					hint={
						<>
							p95 {formatDuration(totals.p95)} · <Delta value={change(totals.p50, previous?.p50)} upIs="bad" />
						</>
					}
				/>
			</StatGrid>

			{insights.length > 0 && (
				<section className={CARD} aria-labelledby="aig-insights">
					<h2 id="aig-insights" className={`mb-2 ${SECTION_TITLE}`}>At a glance</h2>
					<ul className="space-y-1 text-sm">
						{insights.map((item) => (
							<li key={item.text} className="flex gap-2">
								<span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.tone === "warn" ? "bg-amber-500" : item.tone === "bad" ? "bg-red-500" : "bg-zinc-400"}`} />
								<span>
									{item.text}
									{item.drill && (
										<>
											{" "}
											<button type="button" className={`text-cf hover:underline ${FOCUS_RING}`} onClick={() => drill(item.drill!.key, item.drill!.value)}>
												Drill in
											</button>
										</>
									)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className={CARD} aria-labelledby="aig-chart-title">
				<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
					<h2 id="aig-chart-title" className={SECTION_TITLE}>
						{METRICS.find((m) => m.id === metric)!.label} by {GRANULARITY_LABEL[shownGranularity] === "Daily" ? "day" : GRANULARITY_LABEL[shownGranularity] === "Hourly" ? "hour" : "15 minutes"}
						{split !== "none" ? `, split by ${splitPhrase(split)}` : ""}
					</h2>
					<div className="ml-auto flex flex-wrap items-center gap-3">
						<label className="flex items-center gap-1.5 text-xs">
							<span className={MUTED}>Split by</span>
							<select value={split} onChange={(e) => setSplit(e.target.value as Split)} className={`rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}>
								{(Object.keys(SPLIT_LABEL) as Split[])
									.filter((k) => !(k === "gateway" && filter.gateway) && !(k === "model" && filter.model))
									.map((k) => (
										<option key={k} value={k}>
											{k === "none" ? "Nothing (total)" : SPLIT_LABEL[k]}
										</option>
									))}
							</select>
						</label>
						<div className="flex gap-1" role="group" aria-label="Chart metric">
							{METRICS.map((m) => (
								<button
									key={m.id}
									type="button"
									aria-pressed={metric === m.id}
									onClick={() => setMetric(m.id)}
									className={`rounded-md px-2.5 py-1 text-xs ${metric === m.id ? "bg-cf text-white" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"} ${FOCUS_RING}`}
								>
									{m.label}
								</button>
							))}
						</div>
					</div>
				</div>
				<StackedChart
					stacks={stacks}
					split={split}
					granularity={shownGranularity}
					metric={metric}
					onPick={split === "gateway" ? (key) => drill("gateway", key) : split === "model" ? (key) => drill("model", key) : undefined}
				/>
				{split === "source" && (
					<p className={`mt-2 text-xs ${MUTED}`}>
						Workers AI is Cloudflare's own inference; every other provider the gateway forwards to counts as third-party.
					</p>
				)}
			</section>

			<section className={CARD}>
				<h2 className={`mb-1 ${SECTION_TITLE}`}>Breakdown</h2>
				<p className={`mb-2 text-xs ${MUTED}`}>Click a name to drill into it; every number on the page then covers only that slice.</p>
				<Tabs tabs={tabs.map((id) => ({ id, label: TAB_LABEL[id] }))} active={activeTab} onChange={setTab} label="Breakdown by" idPrefix="aig" />
				<TabPanel id={activeTab} idPrefix="aig">
					{activeTab === "status" ? (
						<StatusTable rows={result?.byStatus ?? []} total={totals.requests} />
					) : (
						<BreakdownTable rows={rowsFor[activeTab]} total={totals.requests} dimension={activeTab} onDrill={(value) => drill(activeTab, value)} />
					)}
				</TabPanel>
			</section>

			<section className={CARD}>
				<h2 className={`mb-1 ${SECTION_TITLE}`}>Recent requests</h2>
				<p className={`mb-2 text-xs ${MUTED}`}>
					The latest {result?.recent.length ?? 0} requests in this slice, newest first. Analytics rows can be sampled on busy
					gateways, so this is a picture of the traffic rather than a complete log.
				</p>
				<RecentRequests rows={result?.recent ?? []} onDrill={drill} />
			</section>

			<p className={`text-xs ${MUTED}`}>
				Aggregate analytics from the account's AI Gateway datasets, with field names read from the live schema. Change figures
				compare with the window of the same length just before this one.
			</p>
		</PageShell>
	);
}

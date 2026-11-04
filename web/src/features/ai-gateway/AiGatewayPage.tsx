import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { ALERT_ERROR, BADGE, BADGE_NEUTRAL, CARD, FOCUS_RING, MUTED, SECTION_TITLE } from "../../lib/ui";
import { getHashParams, setHashParam } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import { TIME_PRESETS, type TimeRange } from "../../hooks/useTimeRange";
import { accumulate, budgetFor, bucketMinutes, buildStacks, forecastMonth, sourceOf, windowBuckets, type Split, type StackMetric } from "./stack";
import { useAiGatewayUsage } from "./useAiGatewayUsage";
import { UsageChart, type ChartMode, type ChartType } from "./UsageChart";
import { DonutPanel, type DonutSlice } from "./DonutPanel";
import { storageGet, storageSet } from "../../lib/storage";
import { buildInsights } from "./insights";
import {
	EMPTY_TOTALS,
	FILTER_ORDER,
	GRANULARITY_LABEL,
	SESSION_FLAG_LABEL,
	activeDays,
	providerName,
	granularityFor,
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
	type AiGatewaySessionHealth,
	type AiGatewayTags,
	type SessionFlag,
} from "./types";

const ACCENT = "#f6821f";

/** Granularity, as a cost view offers it: one column per group, a running total, or a bucket size. */
type GranularityChoice = "none" | "accumulated" | AiGatewayGranularity;
const GRANULARITY_CHOICES: { id: GranularityChoice; label: string }[] = [
	{ id: "none", label: "None" },
	{ id: "accumulated", label: "Accumulated" },
	{ id: "daily", label: "Daily" },
	{ id: "hourly", label: "Hourly" },
	{ id: "15m", label: "15 minutes" },
];
/** A bucket size that suits the window: not so fine that a 30-day chart has 2,880 columns, not one column for an hour. */
function bucketFits(choice: AiGatewayGranularity, minutes: number): boolean {
	if (choice === "15m") return minutes <= 1440;
	if (choice === "hourly") return minutes <= 10_080;
	return minutes >= 1440;
}
const CHART_TYPES: { id: ChartType; label: string }[] = [
	{ id: "stacked", label: "Column (stacked)" },
	{ id: "grouped", label: "Column (grouped)" },
	{ id: "line", label: "Line" },
	{ id: "area", label: "Area" },
];
type DonutDimension = "gateway" | "model" | "provider" | "client" | "source" | "tag";
const SELECT_SM = `rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`;

type Metric = StackMetric;
const SPLIT_LABEL: Record<Split, string> = {
	none: "Total",
	gateway: "Gateway",
	model: "Model",
	provider: "Provider",
	client: "Client",
	tag: "Tag",
	source: "Workers AI vs third-party",
};
/** In running text: "split by gateway", but "Workers AI" keeps its capitals. */
const splitPhrase = (split: Split) => (split === "source" ? SPLIT_LABEL.source : SPLIT_LABEL[split].toLowerCase());
const METRICS: { id: Metric; label: string; format: (v: number) => string }[] = [
	{ id: "requests", label: "Requests", format: (v) => compact(v) },
	{ id: "tokens", label: "Tokens", format: (v) => compact(v) },
	{ id: "cost", label: "Spend", format: (v) => formatCost(v) },
	{ id: "errors", label: "Errors", format: (v) => compact(v) },
];


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
type BreakdownTab = Dimension | "client" | "tag" | "status";
const TAB_LABEL: Record<BreakdownTab, string> = { gateway: "Gateways", provider: "Providers", model: "Models", client: "Clients", tag: "Tags", status: "Status codes" };

function BreakdownTable({
	rows,
	total,
	onDrill,
	dimension,
	label = (key) => key,
	heading,
}: {
	rows: BreakdownRow[];
	total: number;
	/** Absent for a breakdown that cannot be drilled into (clients fold many user agents). */
	onDrill?: (key: string) => void;
	dimension: Exclude<BreakdownTab, "status">;
	label?: (key: string) => string;
	/** Column heading, when the tab's own name does not fit (a tag key). */
	heading?: string;
}) {
	if (!rows.length) return <p className={`py-6 text-center text-sm ${MUTED}`}>No traffic in this slice.</p>;
	const max = Math.max(1, ...rows.map((r) => r.requests));
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[760px] text-sm">
				<thead className={`text-left text-xs uppercase tracking-wide ${MUTED}`}>
					<tr>
						<th className="py-2 pr-2 font-medium">{heading ?? TAB_LABEL[dimension].replace(/s$/, "")}</th>
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
								{onDrill ? (
									<button
										type="button"
										onClick={() => onDrill(row.key)}
										className={`max-w-full truncate text-left font-medium text-cf hover:underline ${FOCUS_RING}`}
										title={`Drill into ${label(row.key)}`}
									>
										{label(row.key)}
									</button>
								) : (
									<span className="font-medium">{label(row.key)}</span>
								)}
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
														{row.provider ? providerName(row.provider) : "—"}
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

/** Sessions the gateway's session analysis flagged, by reason. */
function SessionHealthPanel({ health }: { health: AiGatewaySessionHealth }) {
	if (!health.available) {
		return <p className="text-sm text-amber-700 dark:text-amber-400">Session analysis unavailable: {health.reason}.</p>;
	}
	const flags = (Object.keys(SESSION_FLAG_LABEL) as SessionFlag[]).filter((flag) => health.flags[flag] !== null);
	const flagged = flags.filter((flag) => (health.flags[flag] ?? 0) > 0);
	return (
		<>
			<p className={`mb-2 text-xs ${MUTED}`}>
				{compact(health.sessions)} {health.sessions === 1 ? "session" : "sessions"} analysed by AI Gateway
				{health.basis === "primary" ? ", matched by their primary model and provider" : ""}. A session can carry several flags.
			</p>
			{!health.sessions ? (
				<p className={`text-sm ${MUTED}`}>No sessions in this window.</p>
			) : !flagged.length ? (
				<p className="text-sm text-emerald-700 dark:text-emerald-400">No session flagged for cost, duration, cache reuse, prompt size or tool use.</p>
			) : null}
			{health.sessions > 0 && (
				<ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
					{flags.map((flag) => {
						const n = health.flags[flag] ?? 0;
						return (
							<li key={flag} className="flex items-center justify-between gap-3">
								<span className={n ? "" : MUTED}>{SESSION_FLAG_LABEL[flag]}</span>
								<span className={`tabular-nums ${n ? "font-medium text-amber-700 dark:text-amber-400" : MUTED}`}>
									{n ? `${compact(n)} (${formatRate(n / health.sessions)})` : "0"}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}

/**
 * Spend by a custom metadata tag — the cf-aig-metadata header an application sends — for cost
 * allocation by team, cost center or feature. Keys that identify people or single items (user,
 * email, session, anything ending in "id") are listed but cannot be picked: the Worker refuses
 * them, and masks identifying values (emails to their domain) under any other key.
 */
function TagBreakdown({ tags, total, tag, onTag }: { tags: AiGatewayTags | null; total: number; tag: string; onTag: (key: string) => void }) {
	if (!tags) return <p className={`py-6 text-center text-sm ${MUTED}`}>This account's schema carries no request metadata.</p>;
	if (!tags.keys.length) {
		return (
			<p className={`py-6 text-center text-sm ${MUTED}`}>
				No request in this slice carries custom metadata. Applications tag requests with the <code>cf-aig-metadata</code> header —
				for example <code>{'{"team":"search","costCenter":"CC-1042"}'}</code> — and those keys appear here.
			</p>
		);
	}
	const blocked = tags.keys.filter((k) => k.sensitive);
	return (
		<div className="pt-3">
			<label className="mb-3 flex flex-wrap items-center gap-2 text-sm">
				<span className={MUTED}>Break spend down by</span>
				<select value={tag} onChange={(e) => onTag(e.target.value)} className={`rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}>
					<option value="">Choose a tag key…</option>
					{tags.keys.map((k) => (
						<option key={k.key} value={k.key} disabled={k.sensitive}>
							{k.key} ({compact(k.requests)} requests){k.sensitive ? " — identifies people, not shown" : ""}
						</option>
					))}
				</select>
			</label>
			{tag && tags.selected === tag ? (
				<BreakdownTable rows={tags.rows} total={total} dimension="tag" heading={`${tag} value`} />
			) : (
				<p className={`py-4 text-sm ${MUTED}`}>Pick a key — a cost center, team or feature — to see requests and spend for each of its values, and what is not tagged.</p>
			)}
			{blocked.length > 0 && (
				<p className={`mt-2 text-xs ${MUTED}`}>
					{blocked.map((k) => k.key).join(", ")} {blocked.length === 1 ? "names" : "name"} people or single items, so {blocked.length === 1 ? "it is" : "they are"} not broken
					down — a per-user view is a separate decision. Email addresses under any other key show as their domain.
				</p>
			)}
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
	const [showSpend, setShowSpend] = useState(true);
	// The tag key spend is broken down by, carried in the URL (#/ai-gateway?tag=team) like the slice.
	const [tag, setTag] = useState(() => getHashParams().get("tag") ?? "");
	const chooseTag = (key: string) => {
		setTag(key);
		setHashParam("tag", key || null);
		if (!key && split === "tag") setSplit("source");
	};
	const [tab, setTab] = useState<BreakdownTab | null>(null);
	const [granChoice, setGranChoice] = useState<GranularityChoice | null>(null);
	const [chartType, setChartType] = useState<ChartType>("stacked");
	const [donuts, setDonuts] = useState<DonutDimension[]>(["gateway", "model", "provider"]);
	// A monthly budget, per account and per browser: a convenience, not shared state.
	const budgetKey = `flarelens_aig_budget:${session.accountId}`;
	const [budgetText, setBudgetText] = useState(() => storageGet("local", budgetKey) ?? "");
	const monthlyBudget = Number(budgetText) > 0 ? Number(budgetText) : null;
	const saveBudget = (text: string) => {
		setBudgetText(text);
		storageSet("local", budgetKey, text);
	};

	// The bucket size asked for: the one chosen, if it still suits the window, else the window's default.
	const chosenBucket = granChoice && granChoice !== "none" && granChoice !== "accumulated" && bucketFits(granChoice, timeRange.minutes) ? granChoice : null;
	const granularity: AiGatewayGranularity = chosenBucket ?? granularityFor(timeRange.minutes);
	const chartMode: ChartMode = granChoice === "none" ? "none" : granChoice === "accumulated" ? "accumulated" : "buckets";
	const { from, to } = timeRange.bounds();
	const filterKey = FILTER_ORDER.map((k) => filter[k] ?? "").join("\u0000");

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity, filter, tag);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load, filterKey, tag]);

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
		const by = result?.seriesBy;
		const points =
			split === "gateway"
				? by?.gateway
				: split === "model"
					? by?.model
					: split === "source" || split === "provider"
						? by?.provider
						: split === "client"
							? by?.client
							: split === "tag"
								? result?.tags?.series
								: [];
		return buildStacks(result?.series ?? [], points ?? [], split, metric, windowBuckets(from, to, shownGranularity));
		// from/to move with the clock; the window they describe is keyed by the range and the result.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [result, split, metric, shownGranularity, timeRange.minutes]);

	// Spend per bucket for the line over the bars: messages and money on one chart.
	const spendLine = useMemo(
		() =>
			showSpend && metric !== "cost" && chartMode === "buckets" && result?.series.some((p) => p.cost !== null) ? new Map(result.series.map((p) => [p.ts, p.cost ?? 0])) : undefined,
		[showSpend, metric, result, chartMode],
	);
	const shownStacks = useMemo(() => (chartMode === "accumulated" ? accumulate(stacks) : stacks), [stacks, chartMode]);
	// The budget in the charted unit: only for spend, pro-rated to a bucket or to the whole window.
	const budgetLevel =
		metric === "cost" && monthlyBudget && chartMode !== "none"
			? budgetFor(monthlyBudget, chartMode === "accumulated" ? timeRange.minutes : bucketMinutes(shownGranularity))
			: null;
	const forecast = totals.cost !== null ? forecastMonth(totals.cost, timeRange.minutes) : null;
	const measureOf = (row: BreakdownRow): number =>
		metric === "cost" ? (row.cost ?? 0) : metric === "tokens" ? (row.tokensIn ?? 0) + (row.tokensOut ?? 0) : metric === "errors" ? (row.errors ?? 0) : row.requests;
	const donutDims: { id: DonutDimension; label: string }[] = [
		{ id: "gateway", label: "Gateway" },
		{ id: "model", label: "Model" },
		{ id: "provider", label: "Provider" },
		{ id: "client", label: "Client" },
		{ id: "source", label: "Workers AI vs third-party" },
		...(tag && result?.tags?.selected === tag ? [{ id: "tag" as const, label: `Tag: ${tag}` }] : []),
	];
	const slicesFor = (dimension: DonutDimension): DonutSlice[] => {
		const rows =
			dimension === "gateway"
				? result?.byGateway
				: dimension === "model"
					? result?.byModel
					: dimension === "provider" || dimension === "source"
						? result?.byProvider
						: dimension === "client"
							? result?.byClient
							: result?.tags?.rows;
		const slices = (rows ?? []).map((row) => ({ key: dimension === "source" ? sourceOf(row.key) : row.key, value: measureOf(row) }));
		if (dimension !== "source") return slices;
		const folded = new Map<string, number>();
		for (const sl of slices) folded.set(sl.key, (folded.get(sl.key) ?? 0) + sl.value);
		return [...folded].map(([key, value]) => ({ key, value }));
	};
	const metricSpec = METRICS.find((m) => m.id === metric)!;

	const days = useMemo(
		// "of 7" for a 7-day window, though its edges touch 8 calendar dates.
		() => activeDays(result?.series ?? [], Math.max(1, Math.round(timeRange.minutes / 1440))),
		[result, timeRange.minutes],
	);
	const prompt = totals.promptCache;

	// Tabs for the dimensions not already pinned by the filter — a drilled-in dimension has one row.
	const tabs: BreakdownTab[] = [...(["gateway", "provider", "model"] as Dimension[]).filter((d) => !filter[d]), "client", "tag", "status"];
	const activeTab: BreakdownTab = tab && tabs.includes(tab) ? tab : tabs[0];
	const rowsFor: Record<Exclude<BreakdownTab, "status" | "tag">, BreakdownRow[]> = {
		gateway: result?.byGateway ?? [],
		provider: result?.byProvider ?? [],
		model: result?.byModel ?? [],
		client: result?.byClient ?? [],
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
							{/* With prompt caching, tokensIn excludes cache reads — "fresh" keeps it from contradicting the Prompt cache card. */}
							{compact(totals.tokensIn)} {totals.promptCache ? "fresh in" : "in"} / {compact(totals.tokensOut)} out · <Delta value={change(tokens, previous?.tokens)} />
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
				<StatCard
					label="Prompt cache"
					value={prompt && prompt.inputTokens ? formatRate(prompt.readTokens / prompt.inputTokens) : "—"}
					hint={
						prompt && prompt.inputTokens
							? `${compact(prompt.readTokens)} of ${compact(prompt.inputTokens)} input tokens read from the provider's cache${prompt.requestsWithRead !== null && totals.requests ? ` · ${formatRate(prompt.requestsWithRead / totals.requests)} of requests` : ""}`
							: "no input tokens recorded"
					}
				/>
				<StatCard
					label="Sessions"
					value={compact(totals.sessions)}
					hint={
						<>
							{totals.users === null ? "" : totals.users ? `${compact(totals.users)} ${totals.users === 1 ? "user" : "users"} · ` : "no user ids sent · "}
							<Delta value={change(totals.sessions, previous?.sessions)} />
						</>
					}
				/>
				<StatCard
					label="Active days"
					value={`${days.active} of ${days.of}`}
					hint={
						days.active
							? `${totals.cost !== null ? `${formatCost(totals.cost / days.active)} and ` : ""}${compact(Math.round(totals.requests / days.active))} requests per active day`
							: "no requests in this window"
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
				{/* The cost header a cost view opens with: what was spent, where the month is heading, against what budget. */}
				<div className="mb-4 flex flex-wrap items-end gap-x-10 gap-y-3">
					<div>
						<div className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`}>Actual spend</div>
						<div className="text-3xl font-semibold tabular-nums">{formatCost(totals.cost)}</div>
					</div>
					<div>
						<div className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`} title="This calendar month at the window's daily run rate">
							Forecast this month
						</div>
						<div className="text-3xl font-semibold tabular-nums">{forecast === null ? "--" : formatCost(forecast)}</div>
					</div>
					<div>
						<label htmlFor="aig-budget" className={`text-xs font-semibold uppercase tracking-wide ${MUTED}`}>
							Budget
						</label>
						<div className="flex items-baseline gap-1">
							<span className="text-3xl font-semibold">$</span>
							<input
								id="aig-budget"
								type="number"
								min={0}
								step="1"
								inputMode="decimal"
								placeholder="none"
								value={budgetText}
								onChange={(e) => saveBudget(e.target.value)}
								className={`w-28 rounded-md border border-transparent bg-transparent text-3xl font-semibold tabular-nums hover:border-zinc-300 focus:border-cf dark:hover:border-zinc-700 ${FOCUS_RING}`}
							/>
							<span className={`text-sm ${MUTED}`}>/mo</span>
						</div>
					</div>
					{monthlyBudget && forecast !== null && (
						<div className={`text-sm ${forecast > monthlyBudget ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`} role="status">
							{forecast > monthlyBudget
								? `Forecast ${formatRate(forecast / monthlyBudget)} of budget — over by ${formatCost(forecast - monthlyBudget)}`
								: `On track: forecast ${formatRate(forecast / monthlyBudget)} of budget`}
						</div>
					)}
				</div>

				<h2 id="aig-chart-title" className={`mb-2 ${SECTION_TITLE}`}>
					{metricSpec.label}
					{chartMode === "none"
						? " for the window"
						: chartMode === "accumulated"
							? ", accumulated"
							: ` by ${shownGranularity === "daily" ? "day" : shownGranularity === "hourly" ? "hour" : "15 minutes"}`}
					{split !== "none" ? `, split by ${split === "tag" ? `tag ${tag}` : splitPhrase(split)}` : ""}
				</h2>
				<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
					<label className="flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Group by</span>
						<select value={split} onChange={(e) => setSplit(e.target.value as Split)} className={SELECT_SM}>
							{(Object.keys(SPLIT_LABEL) as Split[])
								.filter((k) => !(k === "gateway" && filter.gateway) && !(k === "model" && filter.model) && !(k === "provider" && filter.provider) && !(k === "tag" && !tag))
								.map((k) => (
									<option key={k} value={k}>
										{k === "none" ? "None" : k === "tag" ? `Tag: ${tag}` : SPLIT_LABEL[k]}
									</option>
								))}
						</select>
					</label>
					<label className="flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Granularity</span>
						<select
							value={chartMode === "buckets" ? shownGranularity : chartMode}
							onChange={(e) => setGranChoice(e.target.value as GranularityChoice)}
							className={SELECT_SM}
						>
							{GRANULARITY_CHOICES.map((g) => (
								<option key={g.id} value={g.id} disabled={g.id !== "none" && g.id !== "accumulated" && !bucketFits(g.id as AiGatewayGranularity, timeRange.minutes)}>
									{g.label}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Chart</span>
						<select value={chartMode === "none" ? "stacked" : chartType} disabled={chartMode === "none"} onChange={(e) => setChartType(e.target.value as ChartType)} className={SELECT_SM}>
							{CHART_TYPES.map((t) => (
								<option key={t.id} value={t.id}>{t.label}</option>
							))}
						</select>
					</label>
					{metric !== "cost" && chartMode === "buckets" && (
						<label className="flex items-center gap-1.5 text-xs">
							<input type="checkbox" checked={showSpend} onChange={(e) => setShowSpend(e.target.checked)} />
							<span className={MUTED}>Spend line</span>
						</label>
					)}
					<div className="ml-auto flex gap-1" role="group" aria-label="Chart metric">
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
				<UsageChart
					stacks={shownStacks}
					split={split}
					granularity={shownGranularity}
					measure={metricSpec.label}
					format={metricSpec.format}
					chartType={chartType}
					mode={chartMode}
					label={split === "provider" ? providerName : undefined}
					onPick={
						split === "gateway" ? (key) => drill("gateway", key) : split === "model" ? (key) => drill("model", key) : split === "provider" ? (key) => drill("provider", key) : undefined
					}
					spendLine={spendLine}
					budget={budgetLevel}
				/>
				<p className={`mt-2 text-xs ${MUTED}`}>
					{metric === "cost"
						? monthlyBudget
							? `Budget ${formatCost(monthlyBudget)}/month, pro-rated ${chartMode === "accumulated" ? "to this window" : "to each bar"}; anything above it shows red.`
							: "Set a monthly budget above to draw it on the chart, with overage in red."
						: "Switch to Spend to see the budget line."}
					{split === "source" ? " Workers AI is Cloudflare's own inference; every other provider counts as third-party." : ""}
				</p>
			</section>

			<div className="grid gap-4 lg:grid-cols-3">
				{donuts.map((dimension, i) => (
					<DonutPanel
						key={i}
						idPrefix={`aig-donut-${i}`}
						dimension={dimension}
						dimensions={donutDims}
						onDimension={(next) => setDonuts((prev) => prev.map((d, j) => (j === i ? next : d)))}
						slices={slicesFor(dimension)}
						format={metricSpec.format}
						label={dimension === "provider" ? providerName : undefined}
						onPick={dimension === "gateway" || dimension === "model" || dimension === "provider" ? (key) => drill(dimension, key) : undefined}
					/>
				))}
			</div>

			<section className={CARD}>
				<h2 className={`mb-1 ${SECTION_TITLE}`}>Breakdown</h2>
				<p className={`mb-2 text-xs ${MUTED}`}>
					Click a name to drill into it; every number on the page then covers only that slice. Clients are named from the user
					agent, with versions folded together.
				</p>
				<Tabs tabs={tabs.map((id) => ({ id, label: TAB_LABEL[id] }))} active={activeTab} onChange={setTab} label="Breakdown by" idPrefix="aig" />
				<TabPanel id={activeTab} idPrefix="aig">
					{activeTab === "status" ? (
						<StatusTable rows={result?.byStatus ?? []} total={totals.requests} />
					) : activeTab === "tag" ? (
						<TagBreakdown tags={result?.tags ?? null} total={totals.requests} tag={tag} onTag={chooseTag} />
					) : (
						<BreakdownTable
							rows={rowsFor[activeTab]}
							total={totals.requests}
							dimension={activeTab}
							onDrill={activeTab === "client" ? undefined : (value) => drill(activeTab, value)}
							label={activeTab === "provider" ? providerName : undefined}
						/>
					)}
				</TabPanel>
			</section>

			{result?.sessionHealth && (
				<section className={CARD} aria-labelledby="aig-sessions">
					<h2 id="aig-sessions" className={`mb-1 ${SECTION_TITLE}`}>Session health</h2>
					<SessionHealthPanel health={result.sessionHealth} />
				</section>
			)}

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

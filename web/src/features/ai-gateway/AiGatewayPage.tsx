import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { ALERT_ERROR, BADGE, BADGE_NEUTRAL, CARD, CARD_FLUSH, FOCUS_RING, MUTED, SECTION_TITLE, SELECT_SM } from "../../lib/ui";
import { ChevronDownIcon } from "../../components/Icons";
import { getHashParams, setHashParam } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import { TIME_PRESETS, type TimeRange } from "../../hooks/useTimeRange";
import { accumulate, budgetFor, bucketMinutes, buildStacks, forecastMonth, sourceOf, windowBuckets, type Split, type StackMetric } from "./stack";
import { useAiGatewayUsage } from "./useAiGatewayUsage";
import { UsageChart, type ChartMode, type ChartType } from "./UsageChart";
import { DonutPanel, type DonutSlice } from "./DonutPanel";
import { FlowSankey, type FlowColumn, type FlowDrill } from "./FlowSankey";
import { FlagsPanel, GatewaySettingsPanel, RefusalsPanel, blockedSummary, routeNote, useAiGatewayExtras } from "./GatewayConfig";
import { BudgetsPanel, budgetStatus as rowBudgetStatus, useBudgets, type BudgetRow } from "./Budgets";
import { aliasLetters, useHideNames } from "../../hooks/useHideNames";
import { storageGet, storageSet } from "../../lib/storage";
import { buildInsights, cacheInsight, cacheSavings, coverageGaps, coverageInsight } from "./insights";
import {
	EMPTY_TOTALS,
	FILTER_ORDER,
	UNDRILLABLE,
	GRANULARITY_LABEL,
	SESSION_FLAG_LABEL,
	activeDays,
	providerName,
	shortModel,
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
/** A model as a donut legend has room for it: "@cf/meta/llama-3.3-70b" reads as "llama-3.3-70b". The full id stays in the tooltip. */

/** "At a glance" opens with this many lines; the rest are one click away. */
const INSIGHTS_SHOWN = 3;

/** One figure in the health strip: label, value, and what it is measured against. */
function HealthItem({ label, value, hint, tone, note }: { label: string; value: string; hint: ReactNode; tone?: string; note?: ReactNode }) {
	return (
		<div className="min-w-0">
			<div className={`text-xs font-medium uppercase tracking-wide ${MUTED}`}>{label}</div>
			<div className={`text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
			<div className={`text-xs ${MUTED}`}>{hint}</div>
			{note}
		</div>
	);
}

/**
 * A section that starts closed: the detail a demo does not open on, one click away. The heading
 * names the section; the summary beside it says what is inside without opening it.
 */
function Collapsible({ id, title, summary, children }: { id: string; title: string; summary: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<section className={CARD_FLUSH} aria-labelledby={`${id}-title`}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
				<h3 id={`${id}-title`} className={SECTION_TITLE}>
					<button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((v) => !v)} className={`flex items-center gap-2 ${FOCUS_RING}`}>
						<ChevronDownIcon size={16} className={`transition-transform ${open ? "rotate-180" : "-rotate-90"}`} />
						{title}
					</button>
				</h3>
				<span className={`min-w-0 truncate text-xs ${MUTED}`}>{summary}</span>
			</div>
			{open && (
				<div id={`${id}-panel`} className="border-t border-zinc-200 p-4 dark:border-zinc-800">
					{children}
				</div>
			)}
		</section>
	);
}

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
type DonutDimension = "gateway" | "model" | "provider" | "client" | "user" | "source" | "tag";

type Metric = StackMetric;
const SPLIT_LABEL: Record<Split, string> = {
	none: "Total",
	gateway: "Gateway",
	model: "Model",
	provider: "Provider",
	client: "Client",
	user: "User",
	tag: "Tag",
	source: "Workers AI vs third-party",
	action: "Action",
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

type Dimension = "gateway" | "provider" | "model" | "user";
type BreakdownTab = Dimension | "client" | "tag" | "status";
const TAB_LABEL: Record<BreakdownTab, string> = {
	gateway: "Gateways",
	provider: "Providers",
	model: "Models",
	user: "Users",
	client: "Clients",
	tag: "Tags",
	status: "Status codes",
};

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
								{onDrill && !UNDRILLABLE.has(row.key) ? (
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

function RecentRequests({ rows, onDrill, userName = (key) => key }: { rows: AiGatewayRequestRow[]; onDrill: (key: Dimension, value: string) => void; userName?: (key: string) => string }) {
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
												<dt className={MUTED}>User</dt>
												<dd className="break-all">
													{row.user ? (
														<button type="button" className={`text-cf hover:underline ${FOCUS_RING}`} onClick={() => onDrill("user", row.user)}>
															{userName(row.user)}
														</button>
													) : (
														"not tagged"
													)}
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
	const blocked = tags.keys.filter((k) => k.sensitive && k.key !== "user");
	const hasUserKey = tags.keys.some((k) => k.key === "user");
	return (
		<div className="pt-3">
			<label className="mb-3 flex flex-wrap items-center gap-2 text-sm">
				<span className={MUTED}>Break spend down by</span>
				<select value={tag} onChange={(e) => onTag(e.target.value)} className={`rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}>
					<option value="">Choose a tag key…</option>
					{tags.keys.map((k) => (
						<option key={k.key} value={k.key} disabled={k.sensitive}>
							{k.key} ({compact(k.requests)} requests){k.key === "user" ? " — see the Users tab" : k.sensitive ? " — identifies people, not shown" : ""}
						</option>
					))}
				</select>
			</label>
			{tag && tags.selected === tag ? (
				<BreakdownTable rows={tags.rows} total={total} dimension="tag" heading={`${tag} value`} />
			) : (
				<p className={`py-4 text-sm ${MUTED}`}>Pick a key — a cost center, team or feature — to see requests and spend for each of its values, and what is not tagged.</p>
			)}
			{hasUserKey && <p className={`mt-2 text-xs ${MUTED}`}>The user key has its own breakdown, in the Users tab.</p>}
			{blocked.length > 0 && (
				<p className={`mt-2 text-xs ${MUTED}`}>
					{blocked.map((k) => k.key).join(", ")} {blocked.length === 1 ? "names" : "name"} people or single items, so {blocked.length === 1 ? "it is" : "they are"} not broken
					down. Email addresses under any key other than user show as their domain.
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
	// The chart opens on spend, the figure a demo leads with, unless the window carries no cost
	// at all (no priced models), where requests is the more useful opening. A pick sticks.
	const [pickedMetric, setMetric] = useState<Metric | null>(null);
	const [split, setSplit] = useState<Split>("source");
	// Grouped by action it opens on requests too: blocked and cached requests cost nothing, so by
	// spend the actions worth seeing would not be drawn.
	const metric: Metric = pickedMetric ?? (split === "action" || (result && !result.series.some((p) => p.cost !== null)) ? "requests" : "cost");
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
	// Who, what and where — a user donut falls back to gateways on an account that tags no users.
	const [donuts, setDonuts] = useState<DonutDimension[]>(["user", "model", "provider"]);
	const [showAllInsights, setShowAllInsights] = useState(false);
	const [chartOptions, setChartOptions] = useState(false);
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
	// Gateway settings, routes and the window's refusals: from the REST API, beside the analytics.
	const extras = useAiGatewayExtras(session.token, session.accountId, from, to, `${timeRange.minutes}:${reloadKey}`, filter, filterKey, onAuthError);
	const sliced = FILTER_ORDER.some((k) => filter[k]);
	const [budgets, setBudget] = useBudgets(session.accountId);

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity, filter, tag);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load, filterKey, tag]);

	const applyFilter = (next: AiGatewayFilter) => {
		setFilter(next);
		for (const key of FILTER_ORDER) setHashParam(key, next[key] ?? null);
	};
	const drill = (key: Dimension, value: string) => {
		if (!value || UNDRILLABLE.has(value)) return;
		applyFilter({ ...filter, [key]: value });
		setTab(null);
		// Splitting by the dimension just pinned would leave a single bar.
		if (split === key) setSplit("source");
	};
	// Several dimensions at once — a flow band's user, gateway and model — as one step back out.
	const drillMany = (parts: FlowDrill) => {
		const picked = Object.entries(parts).filter(([, value]) => value && !UNDRILLABLE.has(value)) as [FlowColumn, string][];
		if (!picked.length) return;
		applyFilter({ ...filter, ...Object.fromEntries(picked) });
		setTab(null);
		if (picked.some(([key]) => key === split)) setSplit("source");
	};

	// While presenting with names hidden, each person shows as a stable alias: User A is the busiest,
	// then down the users list, then anyone else on the page in alphabetical order.
	const hideNames = useHideNames();
	const userAlias = useMemo(() => {
		const order: string[] = [];
		const seen = new Set<string>(UNDRILLABLE);
		const add = (key: string | null | undefined) => {
			if (key && !seen.has(key)) {
				seen.add(key);
				order.push(key);
			}
		};
		for (const row of result?.byUser ?? []) add(row.key);
		const rest = [...(result?.flows ?? []), ...(result?.previousFlows ?? [])].map((f) => f.user);
		for (const row of result?.recent ?? []) if (row.user) rest.push(row.user);
		if (filter.user) rest.push(filter.user);
		for (const key of [...new Set(rest)].sort()) add(key);
		return new Map(order.map((key, i) => [key, `User ${aliasLetters(i)}`]));
	}, [result, filter.user]);
	const userName = (key: string) => (!hideNames || UNDRILLABLE.has(key) ? key : (userAlias.get(key) ?? "User"));

	const totals = result?.totals ?? EMPTY_TOTALS;
	const previous = result?.previous ?? null;
	const datasets = result?.datasets;
	const tokens = totals.tokensIn === null && totals.tokensOut === null ? null : (totals.tokensIn ?? 0) + (totals.tokensOut ?? 0);
	// Where protection is missing goes straight after anything failing: it should not wait behind "show more".
	const gaps = useMemo(() => coverageGaps(extras.config, result?.byGateway ?? []), [extras.config, result]);
	const savings = useMemo(() => cacheSavings(result?.flows ?? null), [result]);
	const insights = useMemo(() => {
		if (!result) return [];
		const base = buildInsights(result);
		const coverage = coverageInsight(gaps, result);
		const cache = cacheInsight(savings);
		const firstCalm = base.findIndex((line) => line.tone !== "bad");
		const at = firstCalm < 0 ? base.length : firstCalm;
		return [...base.slice(0, at), ...(coverage ? [coverage] : []), ...base.slice(at), ...(cache ? [cache] : [])];
	}, [result, gaps, savings]);
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
							: split === "user"
								? by?.user
								: split === "action"
									? by?.action
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
		...(result?.byUser ? [{ id: "user" as const, label: "User" }] : []),
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
							: dimension === "user"
								? result?.byUser
								: result?.tags?.rows;
		const slices = (rows ?? []).map((row) => ({ key: dimension === "source" ? sourceOf(row.key) : row.key, value: measureOf(row) }));
		if (dimension !== "source") return slices;
		const folded = new Map<string, number>();
		for (const sl of slices) folded.set(sl.key, (folded.get(sl.key) ?? 0) + sl.value);
		return [...folded].map(([key, value]) => ({ key, value }));
	};
	const metricSpec = METRICS.find((m) => m.id === metric)!;
	// Budgets by user, and by the values of the tag key picked: a team or cost center. Stored under the
	// real name; shown as the screen shows it. Whoever no tag names cannot be held to a budget.
	const budgetRows: BudgetRow[] = [
		...(result?.byUser ?? []).filter((r) => !UNDRILLABLE.has(r.key)).map((r) => ({ id: `user:${r.key}`, kind: "User", label: userName(r.key), cost: r.cost ?? 0 })),
		...(tag && result?.tags?.selected === tag ? result.tags.rows.filter((r) => !UNDRILLABLE.has(r.key)).map((r) => ({ id: `tag:${tag}:${r.key}`, kind: tag, label: r.key, cost: r.cost ?? 0 })) : []),
	].sort((a, b) => b.cost - a.cost);
	const budgetCount = budgetRows.filter((r) => budgets[r.id]).length;
	const budgetsOver = budgetRows.filter((r) => rowBudgetStatus(r.cost, budgets[r.id], timeRange.minutes).status === "over").length;

	const days = useMemo(
		// "of 7" for a 7-day window, though its edges touch 8 calendar dates.
		() => activeDays(result?.series ?? [], Math.max(1, Math.round(timeRange.minutes / 1440))),
		[result, timeRange.minutes],
	);
	const prompt = totals.promptCache;

	// Tabs for the dimensions not already pinned by the filter — a drilled-in dimension has one row.
	const tabs: BreakdownTab[] = [
		...(["gateway", "provider", "model"] as Dimension[]).filter((d) => !filter[d]),
		...(result?.byUser && !filter.user ? (["user"] as const) : []),
		"client",
		"tag",
		"status",
	];
	const activeTab: BreakdownTab = tab && tabs.includes(tab) ? tab : tabs[0];
	const rowsFor: Record<Exclude<BreakdownTab, "status" | "tag">, BreakdownRow[]> = {
		gateway: result?.byGateway ?? [],
		provider: result?.byProvider ?? [],
		model: result?.byModel ?? [],
		user: result?.byUser ?? [],
		client: result?.byClient ?? [],
	};
	const prevLabel = result?.previousWindow
		? `vs ${new Date(result.previousWindow.since).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(result.previousWindow.until).toLocaleDateString([], { month: "short", day: "numeric" })}`
		: "";
	const pinned = FILTER_ORDER.filter((k) => filter[k]);

	// People behind the traffic: the `user` tag's named values, without the untagged remainder.
	const userRows = (result?.byUser ?? []).filter((r) => !UNDRILLABLE.has(r.key));
	const taggedShare = result?.byUser && totals.requests ? userRows.reduce((n, r) => n + r.requests, 0) / totals.requests : null;
	const budgetStatus =
		monthlyBudget && forecast !== null
			? {
					over: forecast > monthlyBudget,
					text:
						forecast > monthlyBudget
							? `Over budget: forecast ${formatRate(forecast / monthlyBudget)} of ${formatCost(monthlyBudget)}`
							: `On track: forecast ${formatRate(forecast / monthlyBudget)} of ${formatCost(monthlyBudget)}`,
				}
			: null;
	const shownInsights = showAllInsights ? insights : insights.slice(0, INSIGHTS_SHOWN);
	const flaggedSessions =
		result?.sessionHealth.available === true ? Object.values(result.sessionHealth.flags).reduce<number>((n, v) => n + (v ?? 0), 0) : null;
	// A donut asked for users on an account that sends none shows gateways instead.
	const donutShown = (d: DonutDimension): DonutDimension => (d === "user" && !result?.byUser ? "gateway" : d);
	const chartTitle = `${metricSpec.label}${
		chartMode === "none" ? " for the window" : chartMode === "accumulated" ? ", accumulated" : ` by ${shownGranularity === "daily" ? "day" : shownGranularity === "hourly" ? "hour" : "15 minutes"}`
	}${split !== "none" ? `, split by ${split === "tag" ? `tag ${tag}` : splitPhrase(split)}` : ""}`;

	return (
		<PageShell progress={progress}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<nav aria-label="AI Gateway slice" className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
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
									<span className="max-w-[20rem] truncate">{key === "user" && filter.user ? userName(filter.user) : filter[key]}</span>
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
				</nav>
				<div className="ml-auto flex gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800" role="group" aria-label="Timeframe">
					{TIME_PRESETS.map((preset) => (
						<button
							key={preset.key}
							type="button"
							aria-pressed={timeRange.preset === preset.key}
							onClick={() => timeRange.setPreset(preset.key)}
							className={`rounded-md px-2.5 py-1 text-xs ${timeRange.preset === preset.key ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"} ${FOCUS_RING}`}
						>
							{preset.label.replace("Last ", "").replace(/^hour$/, "1 hour")}
						</button>
					))}
				</div>
			</div>

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{/* The four numbers a demo opens on: money, volume, tokens, people. */}
			<StatGrid cols={4}>
				<StatCard
					label="Spend"
					value={formatCost(totals.cost)}
					hint={
						<>
							{forecast !== null ? `${formatCost(forecast)} forecast this month · ` : ""}
							<Delta value={change(totals.cost, previous?.cost)} />
						</>
					}
					detail={
						<>
							{budgetStatus && (
								<p role="status" className={`text-xs font-medium ${budgetStatus.over ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
									{budgetStatus.text}
								</p>
							)}
							{datasets && <UnavailableNote status={datasets.spend} label="Spend" />}
						</>
					}
				/>
				<StatCard label="Requests" value={compact(totals.requests)} hint={<Delta value={change(totals.requests, previous?.requests)} />} />
				<StatCard
					label="Tokens"
					value={compact(tokens)}
					hint={
						<>
							{/* With prompt caching, tokensIn excludes cache reads — "fresh" keeps it from contradicting the prompt-cache figure. */}
							{compact(totals.tokensIn)} {totals.promptCache ? "fresh in" : "in"} / {compact(totals.tokensOut)} out · <Delta value={change(tokens, previous?.tokens)} />
						</>
					}
				/>
				{result?.byUser ? (
					<StatCard
						label="Users"
						value={compact(userRows.length)}
						hint={
							taggedShare === null
								? "no requests in this window"
								: `${formatRate(taggedShare)} of requests name a user · ${compact(totals.sessions)} ${totals.sessions === 1 ? "session" : "sessions"}`
						}
					/>
				) : (
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
				)}
			</StatGrid>

			{/* Health in one line: the rates that say whether the traffic is going well. */}
			<section aria-label="Health" className={`${CARD} grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4`}>
				<HealthItem
					label="Error rate"
					value={formatRate(totals.errorRate)}
					tone={totals.errorRate ? "text-red-600 dark:text-red-400" : undefined}
					hint={
						<>
							{totals.errors !== null ? `${compact(totals.errors)} ${totals.errors === 1 ? "error" : "errors"}${totals.rateLimited ? `, ${compact(totals.rateLimited)} rate limited` : ""} · ` : ""}
							<RateDelta current={totals.errorRate} previous={previous?.errorRate} upIs="bad" />
						</>
					}
					note={datasets && <UnavailableNote status={datasets.errors} label="Errors" />}
				/>
				<HealthItem
					label="Gateway cache"
					value={formatRate(totals.cacheHitRate)}
					hint={
						<>
							hit rate · <RateDelta current={totals.cacheHitRate} previous={previous?.cacheHitRate} upIs="good" />
							{savings?.saved ? ` · ≈ ${formatCost(savings.saved)} saved` : ""}
						</>
					}
					note={datasets && <UnavailableNote status={datasets.cache} label="Cache" />}
				/>
				<HealthItem
					label="Latency"
					value={formatDuration(totals.p50)}
					hint={
						<>
							p50 · p95 {formatDuration(totals.p95)} · <Delta value={change(totals.p50, previous?.p50)} upIs="bad" />
						</>
					}
				/>
				<HealthItem
					label="Prompt cache"
					value={prompt && prompt.inputTokens ? formatRate(prompt.readTokens / prompt.inputTokens) : "—"}
					hint={
						prompt && prompt.inputTokens
							? `${compact(prompt.readTokens)} of ${compact(prompt.inputTokens)} input tokens read from the provider's cache${prompt.requestsWithRead !== null && totals.requests ? ` · ${formatRate(prompt.requestsWithRead / totals.requests)} of requests` : ""}`
							: "no input tokens recorded"
					}
				/>
			</section>

			{/* On a wide screen the commentary sits beside the chart, so the donuts stay above a 1080p fold.
			    The breakpoint is in px, not 2xl: presentation mode's larger text raises the root size,
			    and a rem breakpoint would move with it (2xl is 2304px at 150%). */}
			<div className="grid gap-4 min-[1536px]:grid-cols-3">
			{insights.length > 0 && (
				<section className={`${CARD} min-[1536px]:self-start`} aria-labelledby="aig-insights">
					<h2 id="aig-insights" className={`mb-2 ${SECTION_TITLE}`}>At a glance</h2>
					<ul className="space-y-1 text-sm">
						{shownInsights.map((item) => (
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
					{insights.length > INSIGHTS_SHOWN && (
						<button type="button" className={`mt-2 text-xs text-cf hover:underline ${FOCUS_RING}`} onClick={() => setShowAllInsights((v) => !v)}>
							{showAllInsights ? "Show fewer" : `Show ${insights.length - INSIGHTS_SHOWN} more`}
						</button>
					)}
				</section>
			)}

			<section className={`${CARD} min-w-0 min-[1536px]:order-first ${insights.length > 0 ? "min-[1536px]:col-span-2" : "min-[1536px]:col-span-3"}`} aria-labelledby="aig-chart-title">
				<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
					<h2 id="aig-chart-title" className={SECTION_TITLE}>
						{chartTitle}
					</h2>
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
				<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
					<label className="flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Group by</span>
						<select value={split} onChange={(e) => setSplit(e.target.value as Split)} className={SELECT_SM}>
							{(Object.keys(SPLIT_LABEL) as Split[])
								.filter(
									(k) =>
										!(k === "gateway" && filter.gateway) &&
										!(k === "model" && filter.model) &&
										!(k === "provider" && filter.provider) &&
										!(k === "user" && (filter.user || !result?.byUser)) &&
										!(k === "tag" && !tag) &&
										!(k === "action" && !result?.seriesBy.action?.length),
								)
								.map((k) => (
									<option key={k} value={k}>
										{k === "none" ? "None" : k === "tag" ? `Tag: ${tag}` : SPLIT_LABEL[k]}
									</option>
								))}
						</select>
					</label>
					<button
						type="button"
						aria-expanded={chartOptions}
						aria-controls="aig-chart-options"
						onClick={() => setChartOptions((v) => !v)}
						className={`flex items-center gap-1 text-xs ${MUTED} hover:text-zinc-900 dark:hover:text-zinc-100 ${FOCUS_RING}`}
					>
						<ChevronDownIcon size={14} className={`transition-transform ${chartOptions ? "rotate-180" : ""}`} />
						Chart options
					</button>
					<span className={`ml-auto text-xs ${MUTED}`}>{GRANULARITY_LABEL[shownGranularity]} buckets</span>
				</div>
				{chartOptions && (
					<div id="aig-chart-options" className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-950/40">
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
						<div className="flex items-center gap-1.5 text-xs">
							<label htmlFor="aig-budget" className={MUTED}>
								Budget
							</label>
							<span aria-hidden className={MUTED}>$</span>
							<input
								id="aig-budget"
								type="number"
								min={0}
								step="1"
								inputMode="decimal"
								placeholder="none"
								value={budgetText}
								onChange={(e) => saveBudget(e.target.value)}
								className={`w-20 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}
							/>
							<span className={MUTED}>/month</span>
						</div>
					</div>
				)}
				<UsageChart
					stacks={shownStacks}
					split={split}
					granularity={shownGranularity}
					measure={metricSpec.label}
					format={metricSpec.format}
					chartType={chartType}
					mode={chartMode}
					label={split === "provider" ? providerName : split === "user" ? userName : undefined}
					onPick={split === "gateway" || split === "model" || split === "provider" || split === "user" ? (key) => drill(split, key) : undefined}
					spendLine={spendLine}
					budget={budgetLevel}
				/>
				<p className={`mt-2 text-xs ${MUTED}`}>
					{metric === "cost"
						? monthlyBudget
							? `Budget ${formatCost(monthlyBudget)}/month, pro-rated ${chartMode === "accumulated" ? "to this window" : "to each bar"}; anything above it shows red.`
							: "Set a monthly budget under Chart options to draw it on the chart, with overage in red."
						: "Switch to Spend to see the budget line."}
					{split === "source" ? " Workers AI is Cloudflare's own inference; every other provider counts as third-party." : ""}
					{split === "action" ? ` Told from each request's status, as in the diagram below.${metric === "cost" ? " Blocked and cached requests cost nothing, so chart requests to see them." : ""}` : ""}
				</p>
			</section>
			</div>

			<div className="grid gap-4 lg:grid-cols-3">
				{donuts.map((wanted, i) => {
					const dimension = donutShown(wanted);
					return (
						<DonutPanel
							key={i}
							idPrefix={`aig-donut-${i}`}
							dimension={dimension}
							dimensions={donutDims}
							onDimension={(next) => setDonuts((prev) => prev.map((d, j) => (j === i ? next : d)))}
							slices={slicesFor(dimension)}
							format={metricSpec.format}
							label={dimension === "provider" ? providerName : dimension === "model" ? shortModel : dimension === "user" ? userName : undefined}
							title={dimension === "user" ? userName : undefined}
							onPick={dimension === "gateway" || dimension === "model" || dimension === "provider" || dimension === "user" ? (key) => drill(dimension, key) : undefined}
						/>
					);
				})}
			</div>

			{result?.flows && result.flows.length > 0 && (
				<FlowSankey
					flows={result.flows}
					previousFlows={result.previousFlows}
					measure={metric}
					format={metricSpec.format}
					label={(column, key) => (column === "model" ? shortModel(key) : column === "provider" ? providerName(key) : column === "user" ? userName(key) : key)}
					onPick={drillMany}
					tagKey={tag || null}
					blockedHref="#/ai-security"
					blockedNote={blockedSummary(extras.refusals)}
					routeNote={(model) => routeNote(extras.config?.routes, model)}
				/>
			)}

			<h2 className={`pt-2 text-xs font-semibold uppercase tracking-wide ${MUTED}`}>More detail</h2>

			<Collapsible id="aig-breakdown" title="Breakdown" summary={`By ${tabs.map((t) => TAB_LABEL[t].toLowerCase()).join(", ")}`}>
				<p className={`mb-2 text-xs ${MUTED}`}>
					Click a name to drill into it; every number on the page then covers only that slice. Users are the values of the
					<code> user</code> key applications send in the <code>cf-aig-metadata</code> header, shown as sent. Clients are named
					from the user agent, with versions folded together.
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
							heading={activeTab === "user" ? "User" : undefined}
							label={activeTab === "provider" ? providerName : activeTab === "user" ? userName : undefined}
						/>
					)}
				</TabPanel>
			</Collapsible>

			{result?.sessionHealth && (
				<Collapsible
					id="aig-sessions"
					title="Session health"
					summary={
						flaggedSessions === null
							? "unavailable for this slice"
							: `${compact(totals.sessions)} ${totals.sessions === 1 ? "session" : "sessions"} · ${flaggedSessions ? `${compact(flaggedSessions)} ${flaggedSessions === 1 ? "flag" : "flags"} raised` : "nothing flagged"}`
					}
				>
					<p className={`mb-3 text-sm ${MUTED}`}>
						Active {days.active} of {days.of} days
						{days.active
							? ` · ${totals.cost !== null ? `${formatCost(totals.cost / days.active)} and ` : ""}${compact(Math.round(totals.requests / days.active))} requests per active day`
							: ""}
						{` · ${compact(totals.sessions)} ${totals.sessions === 1 ? "session" : "sessions"}`} (<Delta value={change(totals.sessions, previous?.sessions)} />)
					</p>
					<SessionHealthPanel health={result.sessionHealth} />
				</Collapsible>
			)}

			<Collapsible
				id="aig-refusals"
				title="Why requests were refused"
				summary={
					extras.refusals
						? extras.refusals.error
							? extras.refusals.error
							: `${compact(extras.refusals.total)} failed or refused ${sliced ? "in this slice" : "in this window"}${extras.refusals.groups[0] ? ` · most: ${extras.refusals.groups[0].reason.replace(/-/g, " ")}` : ""}`
						: (extras.error ?? "loading…")
				}
			>
				{extras.refusals && !extras.refusals.error ? (
					<RefusalsPanel refusals={extras.refusals} sliced={sliced} />
				) : (
					<p className={`text-xs ${MUTED}`}>
						{extras.refusals?.error ?? extras.error ?? "Reading the AI Gateway logs…"}
						{extras.refusals?.error?.includes("AI Gateway: Read") ? " Add it to the token the deployment uses to see why requests were blocked." : ""}
					</p>
				)}
			</Collapsible>

			<Collapsible
				id="aig-flags"
				title="Flagged but allowed"
				summary={
					extras.flags
						? extras.flags.error
							? extras.flags.error
							: `${compact(extras.flags.flagged)} of ${compact(extras.flags.scanned)} requests read carried a flag`
						: (extras.error ?? "loading…")
				}
			>
				{extras.flags && !extras.flags.error ? (
					<FlagsPanel flags={extras.flags} sliced={sliced} />
				) : (
					<p className={`text-xs ${MUTED}`}>{extras.flags?.error ?? extras.error ?? "Reading the AI Gateway logs…"}</p>
				)}
			</Collapsible>

			<Collapsible
				id="aig-budgets"
				title="Budgets"
				summary={
					budgetCount
						? `${budgetCount} set · ${budgetsOver ? `${budgetsOver} over at this pace` : "all on track"}`
						: "Set a monthly budget per user or tag value"
				}
			>
				<BudgetsPanel rows={budgetRows} budgets={budgets} onBudget={setBudget} minutes={timeRange.minutes} sliced={sliced} />
			</Collapsible>

			<Collapsible
				id="aig-settings"
				title="Gateway settings"
				summary={
					extras.config
						? extras.config.error
							? extras.config.error
							: `${extras.config.gateways.length} gateways · ${extras.config.gateways.filter((g) => g.guardrails).length} with Guardrails · ${extras.config.gateways.filter((g) => g.dlp).length} with DLP · ${extras.config.routes.length} dynamic ${extras.config.routes.length === 1 ? "route" : "routes"}`
						: (extras.error ?? "loading…")
				}
			>
				{extras.config && !extras.config.error ? (
					<GatewaySettingsPanel config={extras.config} focus={filter.gateway} hideNames={hideNames} gaps={gaps} />
				) : (
					<p className={`text-xs ${MUTED}`}>{extras.config?.error ?? extras.error ?? "Reading the gateways…"}</p>
				)}
			</Collapsible>

			<Collapsible id="aig-recent" title="Recent requests" summary={`${result?.recent.length ?? 0} latest, newest first`}>
				<p className={`mb-2 text-xs ${MUTED}`}>
					Analytics rows can be sampled on busy gateways, so this is a picture of the traffic rather than a complete log.
				</p>
				<RecentRequests rows={result?.recent ?? []} onDrill={drill} userName={userName} />
			</Collapsible>

			<p className={`text-xs ${MUTED}`}>
				Aggregate analytics from the account's AI Gateway datasets, with field names read from the live schema. Changes
				compare with the window of the same length just before this one{prevLabel ? ` (${prevLabel.replace(/^vs /, "")})` : ""}.
			</p>
		</PageShell>
	);
}

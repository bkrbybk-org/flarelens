import { useEffect, useMemo } from "react";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { ProgressBar } from "../../components/ProgressBar";
import { AlertIcon, RefreshIcon } from "../../components/Icons";
import type { Kpi, SchemaReadout } from "../../lib/ai-sec/types";
import { BarList, CARD_CLS, DetectionsChart, Sparkline, TrendChart } from "./charts";
import { EventsTable } from "./EventsTable";
import { useAiSecurityData } from "./useAiSecurityData";

/** Mirrors RANGES in the worker's domain/params; the server clamps anything unknown anyway. */
const RANGE_OPTIONS: [string, string][] = [
	["30m", "Last 30 min"],
	["1h", "Last hour"],
	["6h", "Last 6 hours"],
	["24h", "Last 24 hours"],
	["7d", "Last 7 days"],
	["30d", "Last 30 days"],
];

const TONE_TEXT: Record<string, string> = {
	danger: "text-red-600 dark:text-red-400",
	warn: "text-amber-600 dark:text-amber-400",
	neutral: "",
};

const TONE_SPARK: Record<string, string> = {
	danger: "text-red-500",
	warn: "text-amber-500",
	neutral: "text-cf",
};

/**
 * Which detection fields this token's schema actually resolves.
 *
 * Collapsed by default: it matters only when a panel is empty, and then it is the difference
 * between "nothing was detected" and "this KPI cannot be built here at all".
 */
function SchemaReadoutPanel({ schema }: { schema: SchemaReadout }) {
	const missing = schema.rows.filter((row) => !row.resolved);
	return (
		<details className={`${CARD_CLS} text-sm`}>
			<summary className="cursor-pointer select-none font-medium">
				Detection field coverage
				<span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
					{missing.length === 0
						? `all ${schema.rows.length} resolve`
						: `${missing.length} of ${schema.rows.length} unavailable: ${missing.map((row) => row.label).join(", ")}`}
				</span>
			</summary>
			<ul className="mt-3 space-y-2">
				{schema.rows.map((row) => (
					<li key={row.id} className="flex gap-2">
						<span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${row.resolved ? "bg-emerald-500" : "bg-amber-500"}`} />
						<div className="min-w-0">
							<div className="font-medium">
								{row.label}
								{row.field && <span className="ml-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.field}</span>}
							</div>
							{!row.resolved && <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.detail}</div>}
						</div>
					</li>
				))}
			</ul>
			<p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
				Probed {schema.probedAt}
				{schema.dataset ? ` · rows from ${schema.dataset}` : " · no dataset carried the AI fields"}
				{schema.notes.length ? ` · ${schema.notes.join("; ")}` : ""}
			</p>
		</details>
	);
}

function KpiCard({ kpi, spark }: { kpi: Kpi; spark?: number[] }) {
	// Percentage change from zero is undefined, not "+Infinity%".
	const delta = typeof kpi.prev === "number" && kpi.prev > 0 ? ((kpi.value - kpi.prev) / kpi.prev) * 100 : null;
	return (
		<div className={CARD_CLS}>
			<div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{kpi.label}</div>
			<div className={`mt-1 text-3xl font-semibold tabular-nums ${TONE_TEXT[kpi.tone] ?? ""}`}>
				{kpi.value.toLocaleString()}
			</div>
			{delta !== null && (
				<div className={`mt-0.5 text-xs ${delta >= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
					{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs previous period
				</div>
			)}
			{kpi.hint && <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{kpi.hint}</div>}
			{spark && <Sparkline values={spark} className={TONE_SPARK[kpi.tone] ?? "text-cf"} />}
		</div>
	);
}

interface Props {
	session: Session;
	timeRange: TimeRange;
	zoneId: string;
	onAuthError: () => void;
}

const AI_RANGE_STEPS = [
	{ key: "1h", minutes: 60 },
	{ key: "6h", minutes: 360 },
	{ key: "24h", minutes: 1440 },
	{ key: "7d", minutes: 10_080 },
	{ key: "30d", minutes: 43_200 },
];

export function AiSecurityPage({ session, zoneId, timeRange, onAuthError }: Props) {
	const ai = useAiSecurityData(onAuthError);
	const { load } = ai;
	/**
	 * The section's own range vocabulary, chosen as the largest preset the shared window covers.
	 * Its 30m option has no equivalent in the shared picker, so it is simply never selected.
	 */
	const range = AI_RANGE_STEPS.reduce((best, step) => (timeRange.minutes >= step.minutes ? step.key : best), "1h");

	// Deep-linkable, matching how #/waf carries its lookback.

	useEffect(() => {
		load(session.token, session.accountId, zoneId, range);
	}, [session.token, session.accountId, zoneId, range, load]);

	const data = ai.result?.data;

	/*
	 * Series behind each headline tile's sparkline, keyed by KPI id.
	 *
	 * A plain record rather than a memoized lookup function: React Compiler refuses to memoize a
	 * hook that returns a closure, because the identity it hands back cannot be kept stable, and
	 * it skips compiling the whole component when it sees one. Any id without a series simply
	 * has no entry, so its tile renders without a sparkline rather than a flat line implying zero.
	 *
	 * Both arrays are already on the page — the charts below render from exactly these — so the
	 * tiles cost nothing extra and cannot disagree with the charts beneath them.
	 */
	const sparks = useMemo<Record<string, number[]>>(() => {
		if (!data) return {} as Record<string, number[]>;
		const out: Record<string, number[]> = {
			llm: data.trafficSeries.map((p) => p.count),
			injection: data.detectionSeries.map((p) => p.injection),
			pii: data.detectionSeries.map((p) => p.pii),
			unsafe: data.detectionSeries.map((p) => p.unsafe),
			custom: data.detectionSeries.map((p) => p.custom),
		};
		return out;
	}, [data]);

	const trafficSummary = useMemo(() => {
		if (!data?.trafficSeries.length) return "LLM request volume: no data.";
		const total = data.trafficSeries.reduce((sum, p) => sum + p.count, 0);
		return `LLM request volume over ${data.window.label}: ${total.toLocaleString()} requests across ${data.trafficSeries.length} intervals.`;
	}, [data]);

	const detectionsSummary = useMemo(() => {
		if (!data?.detectionSeries.length) return "Detections: no data.";
		const sum = (k: "injection" | "pii" | "unsafe" | "custom") => data.detectionSeries.reduce((t, p) => t + p[k], 0);
		return `Detections over ${data.window.label}: prompt injection ${sum("injection")}, PII ${sum("pii")}, unsafe topic ${sum("unsafe")}, custom topic ${sum("custom")}.`;
	}, [data]);

	return (
		<div className="h-full overflow-y-auto">
			<div className="space-y-4 p-4 md:p-6">
				{ai.progress.running && <ProgressBar percent={ai.progress.percent} />}

				{ai.error && (
					<div role="alert" className="rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
						{ai.error}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					{/* Window comes from the shared picker in the top bar; shown here so the page
					    still states what it is looking at. */}
					<span className="rounded-lg border border-zinc-200 px-2.5 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
						{RANGE_OPTIONS.find(([value]) => value === range)?.[1] ?? range}
					</span>
					<button
						type="button"
						onClick={() => load(session.token, session.accountId, zoneId, range)}
						disabled={ai.loading}
						className="flex items-center gap-2 rounded-lg bg-cf px-3 py-2 text-sm font-medium text-white transition hover:bg-cf-hover disabled:opacity-50"
					>
						<RefreshIcon size={14} className={ai.loading ? "animate-spin" : undefined} />
						Refresh
					</button>
					{data && (
						<span className="text-xs text-zinc-500 dark:text-zinc-400">
							{data.totalEvents.toLocaleString()} flagged request(s) · {data.window.label}
						</span>
					)}
				</div>

				{/* A zone that failed is reported rather than silently dropped: the aggregate would
				    otherwise be quietly short by that zone's traffic. */}
				{data?.zonesWithErrors.length ? (
					<div className="flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
						<AlertIcon size={16} />
						<span>
							{data.zonesWithErrors.length} zone(s) failed to load and are missing from these totals:{" "}
							{data.zonesWithErrors.map((z) => z.zoneName).join(", ")}
						</span>
					</div>
				) : null}

				{ai.result && <SchemaReadoutPanel schema={ai.result.schema} />}

				{!data && !ai.loading && !ai.error && (
					<p className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
						No AI Security telemetry loaded yet.
					</p>
				)}

				{data && (
					<>
						<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
							{data.kpis
								.filter((k) => ["llm", "injection", "pii", "unsafe", "custom"].includes(k.id))
								.map((k) => (
									<KpiCard key={k.id} kpi={k} spark={sparks[k.id]} />
								))}
						</div>

						<div className="grid gap-4 xl:grid-cols-2">
							<TrendChart
								title="LLM request volume"
								series={data.trafficSeries}
								previous={data.trafficSeriesPrev}
								summary={trafficSummary}
							/>
							<DetectionsChart series={data.detectionSeries} summary={detectionsSummary} />
						</div>

						<div className="grid gap-4 xl:grid-cols-3">
							<BarList
								title="Prompt injection score distribution"
								items={data.injectionHistogram}
								emptyText="No scored prompts in this window."
							/>
							<BarList title="PII categories in prompts" items={data.piiBreakdown} emptyText="No PII detected." />
							<BarList title="Unsafe topic categories" items={data.topicBreakdown} emptyText="No unsafe topics detected." />
						</div>

						<div className="grid gap-4 xl:grid-cols-3">
							<BarList title="Custom topic categories" items={data.customBreakdown} emptyText="No custom topics matched." />
							<BarList title="Source IPs" items={data.topIps} emptyText="No flagged requests." />
							<BarList title="Source countries" items={data.topCountries} emptyText="No flagged requests." />
						</div>

						<EventsTable events={data.events} truncated={data.truncated} />

						<section className={CARD_CLS}>
							<h2 className="mb-3 text-sm font-semibold">Zone rollup</h2>
							<div className="overflow-x-auto">
								<table className="w-full border-collapse text-sm">
									<thead>
										<tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
											<th className="px-2 py-2 text-left">Zone</th>
											<th className="px-2 py-2 text-right">LLM requests</th>
											<th className="px-2 py-2 text-right">Injection</th>
											<th className="px-2 py-2 text-right">PII</th>
											<th className="px-2 py-2 text-right">Unsafe</th>
											<th className="px-2 py-2 text-right">Custom</th>
											<th className="px-2 py-2 text-left">Status</th>
										</tr>
									</thead>
									<tbody>
										{data.zoneRollup.map((z) => (
											<tr key={z.zoneId} className="border-b border-zinc-100 dark:border-zinc-800/60">
												<td className="px-2 py-1.5">{z.zoneName}</td>
												<td className="px-2 py-1.5 text-right tabular-nums">{z.llmRequests.toLocaleString()}</td>
												<td className="px-2 py-1.5 text-right tabular-nums">{z.injection.toLocaleString()}</td>
												<td className="px-2 py-1.5 text-right tabular-nums">{z.pii.toLocaleString()}</td>
												<td className="px-2 py-1.5 text-right tabular-nums">{z.unsafe.toLocaleString()}</td>
												<td className="px-2 py-1.5 text-right tabular-nums">{z.custom.toLocaleString()}</td>
												<td className="px-2 py-1.5 text-xs">
													{z.error ? <span className="text-red-600 dark:text-red-400">{z.error}</span> : <span className="text-zinc-500">ok</span>}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}

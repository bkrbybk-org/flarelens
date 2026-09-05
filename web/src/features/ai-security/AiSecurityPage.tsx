import { useEffect, useMemo, useState } from "react";
import { useHashSyncedState } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import { ProgressBar } from "../../components/ProgressBar";
import { AlertIcon, RefreshIcon } from "../../components/Icons";
import type { Kpi } from "../../lib/ai-sec/types";
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
	zoneId: string;
	onAuthError: () => void;
}

export function AiSecurityPage({ session, zoneId, onAuthError }: Props) {
	const ai = useAiSecurityData(onAuthError);
	const { load } = ai;
	const [range, setRange] = useState("24h");

	// Deep-linkable, matching how #/waf carries its lookback.
	useHashSyncedState("range", range, (v) => {
		if (RANGE_OPTIONS.some(([value]) => value === v)) setRange(v);
	});

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

	const selectCls =
		"rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900";

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
					<select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range" className={selectCls}>
						{RANGE_OPTIONS.map(([value, label]) => (
							<option key={value} value={value}>{label}</option>
						))}
					</select>
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

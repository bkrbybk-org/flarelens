import { useEffect, useMemo, useState } from "react";
import { EmptyRow } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, BTN_SECONDARY_SM, CARD, SECTION_TITLE } from "../../lib/ui";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { MetricsChart, type ChartType, type Series } from "./MetricsChart";
import { useWorkersData } from "./useWorkersData";
import {
	WORKER_METRICS,
	errorRate,
	formatCount,
	formatCpu,
	metricValue,
	recordTs,
	totalsOf,
	workerColor,
	type Granularity,
	type WorkerMetric,
} from "./types";

interface WorkersPageProps {
	session: Session;
	timeRange: TimeRange;
	onAuthError: () => void;
}

/** Beyond a week, hourly buckets are too many to read; the upstream dashboard switches too. */
function granularityFor(minutes: number): Granularity {
	return minutes > 7 * 24 * 60 ? "daily" : "hourly";
}

function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (next: T) => void;
	label: string;
}) {
	return (
		<div className="flex items-center gap-1" role="group" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					aria-pressed={value === option.value}
					className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
						value === option.value
							? "bg-cf text-white"
							: "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
					}`}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function WorkersPage({ session, timeRange, onAuthError }: WorkersPageProps) {
	const [granularityOverride, setGranularityOverride] = useState<Granularity | null>(null);
	const [metric, setMetric] = useState<WorkerMetric>("requests");
	const [chartType, setChartType] = useState<ChartType>("line");
	const [excluded, setExcluded] = useState<Set<string>>(new Set());
	const [reloadKey, setReloadKey] = useState(0);

	const { result, scripts, loading, error, progress, load } = useWorkersData(onAuthError);

	// The shared window picks the default bucket size; an explicit choice overrides it until
	// the window changes again.
	const granularity = granularityOverride ?? granularityFor(timeRange.minutes);
	const { from, to } = timeRange.bounds();

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load]);

	// Memoised so the `?? []` fallback does not hand the memos below a new array each render.
	const records = useMemo(() => result?.data ?? [], [result]);
	const timeDimension = result?.timeDimension ?? "datetimeHour";

	// Every worker seen in the window, plus any idle ones the script list adds.
	const allWorkers = useMemo(() => {
		const seen = new Set(records.map((r) => r.dimensions.scriptName));
		for (const script of scripts) seen.add(script);
		return [...seen].sort();
	}, [records, scripts]);

	const visible = useMemo(
		() => records.filter((r) => !excluded.has(r.dimensions.scriptName)),
		[records, excluded],
	);

	const totals = useMemo(() => totalsOf(visible), [visible]);

	const buckets = useMemo(
		() => [...new Set(visible.map((r) => recordTs(r, timeDimension)))].filter(Boolean).sort(),
		[visible, timeDimension],
	);

	const series = useMemo<Series[]>(() => {
		const byWorker = new Map<string, Map<string, number>>();
		for (const record of visible) {
			const worker = record.dimensions.scriptName;
			if (!byWorker.has(worker)) byWorker.set(worker, new Map());
			const ts = recordTs(record, timeDimension);
			byWorker.get(worker)!.set(ts, (byWorker.get(worker)!.get(ts) ?? 0) + metricValue(record, metric));
		}
		return [...byWorker.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([worker, points]) => ({ worker, points: buckets.map((b) => points.get(b) ?? 0) }));
	}, [visible, buckets, metric, timeDimension]);

	const perWorker = useMemo(() => {
		const grouped = new Map<string, typeof records>();
		for (const record of visible) {
			const worker = record.dimensions.scriptName;
			if (!grouped.has(worker)) grouped.set(worker, []);
			grouped.get(worker)!.push(record);
		}
		return [...grouped.entries()]
			.map(([worker, rows]) => ({ worker, totals: totalsOf(rows) }))
			.sort((a, b) => b.totals.requests - a.totals.requests);
	}, [visible]);

	function toggleWorker(worker: string) {
		setExcluded((prev) => {
			const next = new Set(prev);
			if (next.has(worker)) next.delete(worker);
			else next.add(worker);
			return next;
		});
	}

	return (
		<PageShell>
			<div className="flex flex-wrap items-center gap-3">
				<Segmented
					label="Granularity"
					value={granularity}
					onChange={setGranularityOverride}
					options={[
						{ value: "hourly", label: "Hourly" },
						{ value: "daily", label: "Daily" },
					]}
				/>
				<Segmented
					label="Metric"
					value={metric}
					onChange={setMetric}
					options={(Object.keys(WORKER_METRICS) as WorkerMetric[]).map((key) => ({
						value: key,
						label: WORKER_METRICS[key],
					}))}
				/>
				<Segmented
					label="Chart type"
					value={chartType}
					onChange={setChartType}
					options={[
						{ value: "line", label: "Line" },
						{ value: "bar", label: "Bar" },
					]}
				/>
				<button
					type="button"
					onClick={() => setReloadKey((k) => k + 1)}
					disabled={loading}
					className={`ml-auto ${BTN_SECONDARY_SM}`}
				>
					<RefreshIcon size={14} className={loading ? "animate-spin" : ""} />
					Refresh
				</button>
			</div>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{result?.truncated && (
				<div role="status" className={ALERT_WARN}>
					Results were capped at 10,000 rows. Shorten the range, or switch to daily granularity for full coverage.
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard
					label="Requests"
					value={formatCount(totals.requests)}
					hint={buckets.length ? `across ${buckets.length} buckets` : undefined}
				/>
				<StatCard label="Errors" value={formatCount(totals.errors)} hint={`${errorRate(totals).toFixed(2)}% error rate`} />
				<StatCard label="Subrequests" value={formatCount(totals.subrequests)} />
				<StatCard label="CPU P50" value={formatCpu(totals.cpuTimeP50)} hint="mean of bucket medians" />
			</StatGrid>

			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>{WORKER_METRICS[metric]} over time</h2>
				<MetricsChart
					buckets={buckets}
					series={series}
					allWorkers={allWorkers}
					granularity={result?.granularity ?? granularity}
					metric={metric}
					chartType={chartType}
				/>
			</section>

			{allWorkers.length > 0 && (
				<div className="mb-4 flex flex-wrap gap-2">
					{allWorkers.map((worker) => {
						const on = !excluded.has(worker);
						return (
							<button
								key={worker}
								type="button"
								onClick={() => toggleWorker(worker)}
								aria-pressed={on}
								className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
									on ? "border-zinc-300 dark:border-zinc-700" : "border-dashed border-zinc-300 opacity-50 dark:border-zinc-700"
								}`}
							>
								<span className="h-2 w-2 rounded-full" style={{ background: workerColor(worker, allWorkers) }} />
								<code>{worker}</code>
							</button>
						);
					})}
				</div>
			)}

			<section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
				<table className="w-full text-sm">
					<thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
						<tr>
							<th className="px-4 py-2.5 text-left font-medium">Worker</th>
							<th className="px-4 py-2.5 text-right font-medium">Requests</th>
							<th className="px-4 py-2.5 text-right font-medium">Errors</th>
							<th className="px-4 py-2.5 text-right font-medium">Error rate</th>
							<th className="px-4 py-2.5 text-right font-medium">Subrequests</th>
							<th className="px-4 py-2.5 text-right font-medium">CPU P50</th>
						</tr>
					</thead>
					<tbody>
						{perWorker.length === 0 && (
							<EmptyRow colSpan={6} title="No Workers activity in this window" loading={loading} />
						)}
						{perWorker.map(({ worker, totals: row }) => {
							const rate = errorRate(row);
							return (
								<tr key={worker} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
									<td className="px-4 py-2.5">
										<span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ background: workerColor(worker, allWorkers) }} />
										<code className="text-xs">{worker}</code>
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.requests)}</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.errors)}</td>
									<td className={`px-4 py-2.5 text-right tabular-nums ${rate > 1 ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
										{rate.toFixed(2)}%
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.subrequests)}</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{formatCpu(row.cpuTimeP50)}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</section>
		</PageShell>
	);
}

import { useEffect, useMemo, useState } from "react";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import { MetricsChart, type ChartType, type Series } from "./MetricsChart";
import { useWorkersData } from "./useWorkersData";
import {
	WORKER_METRICS,
	WORKER_PRESETS,
	errorRate,
	formatCount,
	formatCpu,
	metricValue,
	recordTs,
	totalsOf,
	workerColor,
	type Granularity,
	type WorkerMetric,
	type WorkerPreset,
} from "./types";

interface WorkersPageProps {
	session: Session;
	onAuthError: () => void;
}

/** Long ranges default to daily buckets, matching the upstream dashboard's auto-switch. */
function defaultGranularity(preset: WorkerPreset): Granularity {
	return preset === "30d" ? "daily" : "hourly";
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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
			<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && <div className="mt-0.5 text-xs text-zinc-400">{sub}</div>}
		</div>
	);
}

export function WorkersPage({ session, onAuthError }: WorkersPageProps) {
	const [preset, setPreset] = useState<WorkerPreset>("24h");
	const [granularity, setGranularity] = useState<Granularity>("hourly");
	const [metric, setMetric] = useState<WorkerMetric>("requests");
	const [chartType, setChartType] = useState<ChartType>("line");
	const [excluded, setExcluded] = useState<Set<string>>(new Set());
	const [reloadKey, setReloadKey] = useState(0);

	const { result, scripts, loading, error, progress, load } = useWorkersData(onAuthError);

	useEffect(() => {
		const to = new Date();
		const from = new Date(to.getTime() - WORKER_PRESETS[preset].ms);
		load(session.token, session.accountId, from.toISOString(), to.toISOString(), granularity);
	}, [session.token, session.accountId, preset, granularity, reloadKey, load]);

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
		<div className="h-full overflow-auto p-4 md:p-6">
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<Segmented
					label="Time range"
					value={preset}
					onChange={(next) => {
						setPreset(next);
						setGranularity(defaultGranularity(next));
					}}
					options={(Object.keys(WORKER_PRESETS) as WorkerPreset[]).map((key) => ({
						value: key,
						label: WORKER_PRESETS[key].label,
					}))}
				/>
				<Segmented
					label="Granularity"
					value={granularity}
					onChange={setGranularity}
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
					className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					<RefreshIcon size={14} className={loading ? "animate-spin" : ""} />
					Refresh
				</button>
			</div>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className="mb-4 rounded-lg border border-red-300/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
					{error}
				</div>
			)}

			{result?.truncated && (
				<div role="status" className="mb-4 rounded-lg border border-amber-300/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
					Results were capped at 10,000 rows. Shorten the range, or switch to daily granularity for full coverage.
				</div>
			)}

			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatCard
					label="Requests"
					value={formatCount(totals.requests)}
					sub={buckets.length ? `across ${buckets.length} buckets` : undefined}
				/>
				<StatCard label="Errors" value={formatCount(totals.errors)} sub={`${errorRate(totals).toFixed(2)}% error rate`} />
				<StatCard label="Subrequests" value={formatCount(totals.subrequests)} />
				<StatCard label="CPU P50" value={formatCpu(totals.cpuTimeP50)} sub="mean of bucket medians" />
			</div>

			<section className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="mb-3 text-sm font-semibold">{WORKER_METRICS[metric]} over time</h2>
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
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
									{loading ? "Loading…" : "No data for this time range"}
								</td>
							</tr>
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
		</div>
	);
}

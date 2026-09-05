import { useEffect, useState } from "react";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { useWorkersAi } from "./useWorkersAi";
import {
	AI_METRICS,
	aiBucketLabel,
	formatCompact,
	formatLatency,
	metricOf,
	shortModel,
	type AiGranularity,
	type AiMetric,
	type AiSeriesPoint,
} from "./types";

const CARD = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
const ACCENT = "#f6821f";

const W = 960;
const H = 220;
const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / magnitude) * magnitude;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className={CARD}>
			<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && <div className="mt-0.5 text-xs text-zinc-400">{sub}</div>}
		</div>
	);
}

function InferenceChart({
	series,
	granularity,
	metric,
}: {
	series: AiSeriesPoint[];
	granularity: AiGranularity;
	metric: AiMetric;
}) {
	const innerH = H - PAD_T - PAD_B;
	const slot = (W - PAD_L - PAD_R) / Math.max(1, series.length);
	const barW = Math.max(1, slot * 0.7);
	const max = niceMax(Math.max(1, ...series.map((p) => metricOf(p, metric))));

	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: W,
		viewHeight: H,
		plotLeft: PAD_L,
		plotRight: W - PAD_R,
		mode: "slot",
	});

	if (!series.length) {
		return <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">No inference in this window.</p>;
	}

	const point = hover === null ? null : series[hover.index];

	return (
		<div className="relative">
			<svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full" role="img" aria-label={`${metric} over time`} {...hoverProps}>
				{[0, 0.5, 1].map((fraction) => {
					const y = PAD_T + innerH * fraction;
					return (
						<g key={fraction}>
							<line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="stroke-zinc-200 dark:stroke-zinc-800" />
							<text x={PAD_L - 8} y={y + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
								{formatCompact(max * (1 - fraction))}
							</text>
						</g>
					);
				})}
				{series.map((p, i) => {
					const h = (metricOf(p, metric) / max) * innerH;
					return h > 0 ? (
						<rect key={p.ts} x={PAD_L + i * slot} y={PAD_T + innerH - h} width={barW} height={h} fill={ACCENT} />
					) : null;
				})}
				<text x={PAD_L} y={H - 8} className="fill-zinc-400 text-[10px]">{aiBucketLabel(series[0].ts, granularity)}</text>
				<text x={W - PAD_R} y={H - 8} textAnchor="end" className="fill-zinc-400 text-[10px]">
					{aiBucketLabel(series[series.length - 1].ts, granularity)}
				</text>
				{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
			</svg>
			<ChartTooltip
				hover={hover}
				header={point ? aiBucketLabel(point.ts, granularity) : ""}
				rows={
					point
						? [
							{ label: "Requests", value: formatCompact(point.requests), color: ACCENT },
							{ label: "Neurons", value: formatCompact(point.neurons), color: "#a855f7" },
							{ label: "Tokens in", value: formatCompact(point.inputTokens), color: "#3b82f6" },
							{ label: "Tokens out", value: formatCompact(point.outputTokens), color: "#22c55e" },
							{ label: "Errors", value: formatCompact(point.errors), color: "#ef4444", muted: point.errors === 0 },
						]
						: []
				}
				footer={point ? `Avg ${formatLatency(point.requests ? point.inferenceTimeMs / point.requests : null)}` : undefined}
			/>
		</div>
	);
}

export function WorkersAiPage({
	session,
	timeRange,
	onAuthError,
}: {
	session: Session;
	timeRange: TimeRange;
	onAuthError: () => void;
}) {
	const [metric, setMetric] = useState<AiMetric>("requests");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useWorkersAi(onAuthError);

	const granularity: AiGranularity = timeRange.minutes > 7 * 24 * 60 ? "daily" : "hourly";
	const { from, to } = timeRange.bounds();

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load]);

	const totals = result?.totals ?? {
		requests: 0, neurons: 0, inputTokens: 0, outputTokens: 0, inferenceTimeMs: 0, errors: 0,
	};
	const avgLatency = totals.requests ? totals.inferenceTimeMs / totals.requests : null;

	return (
		<div className="h-full overflow-auto p-4 md:p-6">
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-1" role="group" aria-label="Metric">
					{(Object.keys(AI_METRICS) as AiMetric[]).map((key) => (
						<button
							key={key}
							type="button"
							onClick={() => setMetric(key)}
							aria-pressed={metric === key}
							className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
								metric === key
									? "bg-cf text-white"
									: "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
							}`}
						>
							{AI_METRICS[key]}
						</button>
					))}
				</div>
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

			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
				<StatCard label="Requests" value={formatCompact(totals.requests)} />
				<StatCard label="Neurons" value={formatCompact(totals.neurons)} sub="Cloudflare's billing unit" />
				<StatCard label="Tokens" value={formatCompact(totals.inputTokens + totals.outputTokens)} sub={`${formatCompact(totals.inputTokens)} in / ${formatCompact(totals.outputTokens)} out`} />
				<StatCard label="Avg latency" value={formatLatency(avgLatency)} sub="per inference" />
				<StatCard label="Errors" value={formatCompact(totals.errors)} sub={totals.errors === 0 ? "none in this window" : undefined} />
			</div>

			<section className={`${CARD} mb-4`}>
				<h2 className="mb-3 text-sm font-semibold">{AI_METRICS[metric]} over time</h2>
				<InferenceChart series={result?.series ?? []} granularity={result?.granularity ?? granularity} metric={metric} />
			</section>

			<section className={`${CARD} mb-4 p-0`}>
				<h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800">Models</h2>
				<table className="w-full text-sm">
					<thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
						<tr>
							<th className="px-4 py-2.5 text-left font-medium">Model</th>
							<th className="px-4 py-2.5 text-right font-medium">Requests</th>
							<th className="px-4 py-2.5 text-right font-medium">Neurons</th>
							<th className="px-4 py-2.5 text-right font-medium">Tokens in / out</th>
							<th className="px-4 py-2.5 text-right font-medium">Avg latency</th>
							<th className="px-4 py-2.5 text-right font-medium">Errors</th>
						</tr>
					</thead>
					<tbody>
						{(result?.byModel.length ?? 0) === 0 && (
							<tr>
								<td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
									{loading ? "Loading…" : "No models invoked in this window"}
								</td>
							</tr>
						)}
						{result?.byModel.map((row) => (
							<tr key={row.modelId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
								<td className="px-4 py-2.5">
									<code className="text-xs" title={row.modelId}>{shortModel(row.modelId)}</code>
								</td>
								<td className="px-4 py-2.5 text-right tabular-nums">{formatCompact(row.requests)}</td>
								<td className="px-4 py-2.5 text-right tabular-nums">{formatCompact(row.neurons)}</td>
								<td className="px-4 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
									{formatCompact(row.inputTokens)} / {formatCompact(row.outputTokens)}
								</td>
								<td className="px-4 py-2.5 text-right tabular-nums">{formatLatency(row.avgLatencyMs)}</td>
								<td className={`px-4 py-2.5 text-right tabular-nums ${row.errors > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
									{formatCompact(row.errors)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<div className="grid gap-4 lg:grid-cols-2">
				<section className={CARD}>
					<h2 className="mb-3 text-sm font-semibold">Request sources</h2>
					{(result?.bySource.length ?? 0) === 0 ? (
						<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No source data.</p>
					) : (
						<ul className="space-y-2 text-sm">
							{result?.bySource.map((row) => (
								<li key={row.key} className="flex items-baseline justify-between gap-3">
									<span className="truncate">{row.key}</span>
									<span className="tabular-nums text-zinc-600 dark:text-zinc-300">
										{formatCompact(row.requests)}
										<span className="ml-1.5 text-xs text-zinc-400">{formatCompact(row.neurons)} neurons</span>
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
				<section className={CARD}>
					<h2 className="mb-3 text-sm font-semibold">Errors by code</h2>
					{(result?.errorsByCode.length ?? 0) === 0 ? (
						<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No failed inference in this window.</p>
					) : (
						<ul className="space-y-2 text-sm">
							{result?.errorsByCode.map((row) => (
								<li key={row.code} className="flex items-baseline justify-between gap-3">
									<code className="text-xs">{row.code}</code>
									<span className="tabular-nums text-red-600 dark:text-red-400">{formatCompact(row.requests)}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

import { useEffect, useState } from "react";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { useGatewayUsage } from "./useGatewayUsage";
import {
	EMPTY_TOTALS,
	blockRate,
	compactCount as compact,
	gatewayBucketLabel as bucketLabel,
	type GatewayBreakdownRow as BreakdownRow,
	type GatewayGranularity,
	type GatewayPoint as Point,
} from "./types";

const CARD = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
const ALLOWED_COLOR = "#10b981";
const BLOCKED_COLOR = "#ef4444";

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

/** Stacked allowed/blocked columns. Blocked sits at the bottom so it stays visible when rare. */
function VerdictChart({ series, granularity, label }: { series: Point[]; granularity: GatewayGranularity; label: string }) {
	const innerH = H - PAD_T - PAD_B;
	const slot = (W - PAD_L - PAD_R) / Math.max(1, series.length);
	const barW = Math.max(1, slot * 0.75);
	const max = niceMax(Math.max(1, ...series.map((p) => p.allowed + p.blocked)));

	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: W,
		viewHeight: H,
		plotLeft: PAD_L,
		plotRight: W - PAD_R,
		mode: "slot",
	});

	if (!series.length) {
		return <p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No {label} traffic in this window.</p>;
	}
	const point = hover === null ? null : series[hover.index];

	return (
		<div className="relative">
			<svg viewBox={`0 0 ${W} ${H}`} className="h-[200px] w-full" role="img" aria-label={`${label} over time`} {...hoverProps}>
				{[0, 0.5, 1].map((fraction) => {
					const y = PAD_T + innerH * fraction;
					return (
						<g key={fraction}>
							<line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} className="stroke-zinc-200 dark:stroke-zinc-800" />
							<text x={PAD_L - 8} y={y + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
								{compact(Math.round(max * (1 - fraction)))}
							</text>
						</g>
					);
				})}
				{series.map((p, i) => {
					const x = PAD_L + i * slot;
					const blockedH = (p.blocked / max) * innerH;
					const allowedH = (p.allowed / max) * innerH;
					return (
						<g key={p.ts}>
							{blockedH > 0 && <rect x={x} y={PAD_T + innerH - blockedH} width={barW} height={blockedH} fill={BLOCKED_COLOR} />}
							{allowedH > 0 && (
								<rect x={x} y={PAD_T + innerH - blockedH - allowedH} width={barW} height={allowedH} fill={ALLOWED_COLOR} />
							)}
						</g>
					);
				})}
				{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
			</svg>
			<ChartTooltip
				hover={hover}
				header={point ? bucketLabel(point.ts, granularity) : ""}
				rows={
					point
						? [
							{ label: "Allowed", value: compact(point.allowed), color: ALLOWED_COLOR },
							{ label: "Blocked", value: compact(point.blocked), color: BLOCKED_COLOR, muted: point.blocked === 0 },
						]
						: []
				}
				footer={point ? `Total ${compact(point.allowed + point.blocked)}` : undefined}
			/>
		</div>
	);
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

function BreakdownCard({ title, rows, emptyText }: { title: string; rows: BreakdownRow[]; emptyText: string }) {
	const max = Math.max(1, ...rows.map((r) => r.total));
	return (
		<section className={CARD}>
			<h2 className="mb-3 text-sm font-semibold">{title}</h2>
			{rows.length === 0 ? (
				<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{emptyText}</p>
			) : (
				<ul className="space-y-2">
					{rows.slice(0, 10).map((row) => (
						<li key={row.key}>
							<div className="flex items-baseline justify-between gap-3 text-sm">
								<span className="min-w-0 truncate" title={row.key}>{row.key}</span>
								<span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">
									{compact(row.total)}
									{row.blocked > 0 && (
										<span className="ml-1.5 text-xs text-red-600 dark:text-red-400">{compact(row.blocked)} blocked</span>
									)}
								</span>
							</div>
							<div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
								<div style={{ width: `${(row.allowed / max) * 100}%`, background: ALLOWED_COLOR }} />
								<div style={{ width: `${(row.blocked / max) * 100}%`, background: BLOCKED_COLOR }} />
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

export function GatewayPage({
	session,
	timeRange,
	onAuthError,
}: {
	session: Session;
	timeRange: TimeRange;
	onAuthError: () => void;
}) {
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useGatewayUsage(onAuthError);

	const granularity: GatewayGranularity = timeRange.minutes > 7 * 24 * 60 ? "daily" : "hourly";
	const { from, to } = timeRange.bounds();

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load]);

	const dns = result?.dns;
	const http = result?.http;
	const empty = EMPTY_TOTALS;

	return (
		<div className="h-full overflow-auto p-4 md:p-6">
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{granularity === "daily" ? "Daily buckets" : "Hourly buckets"}
				</span>
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

			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatCard label="DNS queries" value={compact((dns?.totals ?? empty).total)} />
				<StatCard label="DNS blocked" value={compact((dns?.totals ?? empty).blocked)} sub={`${blockRate(dns?.totals ?? empty)} of queries`} />
				<StatCard label="HTTP requests" value={compact((http?.totals ?? empty).total)} />
				<StatCard label="HTTP blocked" value={compact((http?.totals ?? empty).blocked)} sub={`${blockRate(http?.totals ?? empty)} of requests`} />
			</div>

			<section className={`${CARD} mb-4`}>
				<div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
					<h2 className="text-sm font-semibold">DNS queries over time</h2>
					<div className="flex gap-3 text-xs text-zinc-500 dark:text-zinc-400">
						<span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: ALLOWED_COLOR }} /> Allowed</span>
						<span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: BLOCKED_COLOR }} /> Blocked</span>
					</div>
				</div>
				<VerdictChart series={dns?.series ?? []} granularity={result?.granularity ?? granularity} label="DNS" />
			</section>

			<section className={`${CARD} mb-4`}>
				<h2 className="mb-3 text-sm font-semibold">Gateway HTTP requests over time</h2>
				<VerdictChart series={http?.series ?? []} granularity={result?.granularity ?? granularity} label="HTTP" />
			</section>

			<div className="grid gap-4 lg:grid-cols-2">
				<BreakdownCard title="DNS categories" rows={dns?.byCategory ?? []} emptyText="No categorised DNS traffic." />
				<BreakdownCard title="DNS policies" rows={dns?.byPolicy ?? []} emptyText="No policy matches." />
				<BreakdownCard title="HTTP hosts" rows={http?.byHost ?? []} emptyText="No HTTP traffic." />
				<BreakdownCard title="HTTP actions" rows={http?.byAction ?? []} emptyText="No HTTP traffic." />
			</div>

			<p className="mt-4 text-xs text-zinc-400">
				Aggregate only. Both Gateway datasets can break traffic down by user, device and source IP; none of those
				dimensions are queried.
			</p>
		</div>
	);
}

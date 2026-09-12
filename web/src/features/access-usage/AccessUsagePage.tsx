import { useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, BTN_SECONDARY_SM, CARD, SECTION_TITLE } from "../../lib/ui";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import { useAccessUsage } from "./useAccessUsage";
import type { TimeRange } from "../../hooks/useTimeRange";
import {
	FAILURE_COLOR,
	SUCCESS_COLOR,
	accessBucketLabel,
	formatLogins,
	successRate,
	type AccessBreakdownRow,
	type AccessGranularity,
	type AccessUsagePoint,
} from "./types";

/** Cloudflare refuses a window wider than one week on the login dataset. */
const MAX_MINUTES = 7 * 24 * 60 - 1;


const CHART_W = 960;
const CHART_H = 220;
const PAD_L = 46;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;

function niceMax(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	return Math.ceil(value / magnitude) * magnitude;
}

/** Stacked success/failure columns with a hover readout, matching the app's other charts. */
function LoginChart({ series, granularity }: { series: AccessUsagePoint[]; granularity: AccessGranularity }) {
	const max = niceMax(Math.max(1, ...series.map((p) => p.success + p.failure)));
	const innerH = CHART_H - PAD_T - PAD_B;
	const slot = (CHART_W - PAD_L - PAD_R) / Math.max(1, series.length);
	const barW = Math.max(1, slot * 0.7);

	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: CHART_W,
		viewHeight: CHART_H,
		plotLeft: PAD_L,
		plotRight: CHART_W - PAD_R,
		mode: "slot",
	});

	if (!series.length) {
		return <EmptyState title="No logins in this window" />;
	}

	const point = hover === null ? null : series[hover.index];

	return (
		<div className="relative">
			<svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-[220px] w-full" role="img" aria-label="Access logins over time" {...hoverProps}>
				{[0, 0.5, 1].map((fraction) => {
					const y = PAD_T + innerH * fraction;
					return (
						<g key={fraction}>
							<line x1={PAD_L} x2={CHART_W - PAD_R} y1={y} y2={y} className="stroke-zinc-200 dark:stroke-zinc-800" />
							<text x={PAD_L - 8} y={y + 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
								{formatLogins(Math.round(max * (1 - fraction)))}
							</text>
						</g>
					);
				})}
				{series.map((p, i) => {
					const totalH = ((p.success + p.failure) / max) * innerH;
					const failH = ((p.failure) / max) * innerH;
					const x = PAD_L + i * slot;
					return (
						<g key={p.ts}>
							{failH > 0 && <rect x={x} y={PAD_T + innerH - failH} width={barW} height={failH} fill={FAILURE_COLOR} />}
							{totalH - failH > 0 && (
								<rect x={x} y={PAD_T + innerH - totalH} width={barW} height={totalH - failH} fill={SUCCESS_COLOR} />
							)}
						</g>
					);
				})}
				<text x={PAD_L} y={CHART_H - 8} className="fill-zinc-400 text-[10px]">
					{accessBucketLabel(series[0].ts, granularity)}
				</text>
				<text x={CHART_W - PAD_R} y={CHART_H - 8} textAnchor="end" className="fill-zinc-400 text-[10px]">
					{accessBucketLabel(series[series.length - 1].ts, granularity)}
				</text>
				{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
			</svg>
			<ChartTooltip
				hover={hover}
				header={point ? accessBucketLabel(point.ts, granularity) : ""}
				rows={
					point
						? [
							{ label: "Successful", value: formatLogins(point.success), color: SUCCESS_COLOR },
							{ label: "Failed", value: formatLogins(point.failure), color: FAILURE_COLOR, muted: point.failure === 0 },
						]
						: []
				}
				footer={point ? `Total ${formatLogins(point.success + point.failure)}` : undefined}
			/>
		</div>
	);
}

function BreakdownCard({ title, rows, emptyText }: { title: string; rows: AccessBreakdownRow[]; emptyText: string }) {
	const max = Math.max(1, ...rows.map((r) => r.total));
	return (
		<section className={CARD}>
			<h2 className={`mb-3 ${SECTION_TITLE}`}>{title}</h2>
			{rows.length === 0 ? (
				<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{emptyText}</p>
			) : (
				<ul className="space-y-2">
					{rows.slice(0, 10).map((row) => (
						<li key={row.key}>
							<div className="flex items-baseline justify-between gap-3 text-sm">
								<span className="min-w-0 truncate" title={row.key}>{row.key}</span>
								<span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">
									{formatLogins(row.total)}
									{row.failure > 0 && (
										<span className="ml-1.5 text-xs text-red-600 dark:text-red-400">{formatLogins(row.failure)} failed</span>
									)}
								</span>
							</div>
							{/* Failures render as their own segment so a mostly-failing app is visible
							    at a glance rather than looking like healthy volume. */}
							<div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
								<div style={{ width: `${(row.success / max) * 100}%`, background: SUCCESS_COLOR }} />
								<div style={{ width: `${(row.failure / max) * 100}%`, background: FAILURE_COLOR }} />
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

export function AccessUsagePage({
	session,
	timeRange,
	onAuthError,
}: {
	session: Session;
	timeRange: TimeRange;
	onAuthError: () => void;
}) {
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useAccessUsage(onAuthError);

	const { minutes, clamped } = timeRange.clamp(MAX_MINUTES);
	// A day or more of data is unreadable hour by hour at this width.
	const granularity: AccessGranularity = minutes > 24 * 60 ? "daily" : "hourly";
	const { from, to } = timeRange.bounds(MAX_MINUTES);

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// `from`/`to` are recomputed per render; the window itself is what should retrigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, minutes, granularity, reloadKey, load]);

	const totals = result?.totals ?? { success: 0, failure: 0, total: 0 };

	return (
		<PageShell>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{granularity === "daily" ? "Daily buckets" : "Hourly buckets"}
				</span>
				{clamped && (
					<span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
						Cloudflare caps Access login data at 7 days — showing the last week.
					</span>
				)}
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
					Results were capped. Shorten the range for full coverage.
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard label="Logins" value={formatLogins(totals.total)} hint="sampled by Cloudflare" />
				<StatCard label="Successful" value={formatLogins(totals.success)} hint={`${successRate(totals)} success rate`} />
				<StatCard label="Failed" value={formatLogins(totals.failure)} hint={totals.failure === 0 ? "none in this window" : undefined} />
				<StatCard label="Apps reached" value={String(result?.byApp.length ?? 0)} hint="with at least one login" />
			</StatGrid>

			<section className={`${CARD}`}>
				<div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
					<h2 className={SECTION_TITLE}>Logins over time</h2>
					<div className="flex gap-3 text-xs text-zinc-500 dark:text-zinc-400">
						<span className="inline-flex items-center gap-1.5">
							<span className="h-2 w-2 rounded-sm" style={{ background: SUCCESS_COLOR }} /> Successful
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span className="h-2 w-2 rounded-sm" style={{ background: FAILURE_COLOR }} /> Failed
						</span>
					</div>
				</div>
				<LoginChart series={result?.series ?? []} granularity={result?.granularity ?? granularity} />
			</section>

			<div className="grid gap-4 lg:grid-cols-3">
				<BreakdownCard title="Top applications" rows={result?.byApp ?? []} emptyText="No application logins in this window." />
				<BreakdownCard title="Identity providers" rows={result?.byIdentityProvider ?? []} emptyText="No identity provider activity." />
				<BreakdownCard title="Countries" rows={result?.byCountry ?? []} emptyText="No country data." />
			</div>

			<p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
				Counts come from Cloudflare's adaptively sampled login dataset, so they are scaled estimates rather than exact
				totals. Per-user identities are deliberately not queried.
			</p>
		</PageShell>
	);
}

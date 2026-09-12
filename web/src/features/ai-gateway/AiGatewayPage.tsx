import { useCallback, useEffect, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, CARD, SECTION_TITLE } from "../../lib/ui";
import { ChartTooltip, HoverGuide, useChartHover } from "../../components/chart/ChartHover";
import { ProgressBar } from "../../components/ProgressBar";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { useAiGatewayUsage } from "./useAiGatewayUsage";
import {
	EMPTY_TOTALS,
	aiGatewayBucketLabel as bucketLabel,
	compactCount as compact,
	formatCost,
	formatRate,
	type AiGatewayBreakdownRow as BreakdownRow,
	type AiGatewayDatasetStatus as DatasetStatus,
	type AiGatewayGranularity,
	type AiGatewaySeriesPoint as Point,
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

function RequestsChart({ series, granularity }: { series: Point[]; granularity: AiGatewayGranularity }) {
	const innerH = H - PAD_T - PAD_B;
	const slot = (W - PAD_L - PAD_R) / Math.max(1, series.length);
	const barW = Math.max(1, slot * 0.7);
	const max = niceMax(Math.max(1, ...series.map((p) => p.requests)));

	const { hover, hoverProps } = useChartHover({
		count: series.length,
		viewWidth: W,
		viewHeight: H,
		plotLeft: PAD_L,
		plotRight: W - PAD_R,
		mode: "slot",
	});

	if (!series.length) {
		return <EmptyNote title="No AI Gateway requests in this window" />;
	}
	const point = hover === null ? null : series[hover.index];

	return (
		<div className="relative">
			<svg viewBox={`0 0 ${W} ${H}`} className="h-[200px] w-full" role="img" aria-label="Requests over time" {...hoverProps}>
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
					const h = (p.requests / max) * innerH;
					return h > 0 ? (
						<rect key={p.ts} x={PAD_L + i * slot} y={PAD_T + innerH - h} width={barW} height={h} fill={ACCENT} />
					) : null;
				})}
				{hover !== null && <HoverGuide x={PAD_L + slot * (hover.index + 0.5)} top={PAD_T} bottom={PAD_T + innerH} />}
			</svg>
			<ChartTooltip
				hover={hover}
				header={point ? bucketLabel(point.ts, granularity) : ""}
				rows={point ? [{ label: "Requests", value: compact(point.requests), color: ACCENT }] : []}
			/>
		</div>
	);
}

function BreakdownCard({ title, rows, emptyText }: { title: string; rows: BreakdownRow[]; emptyText: string }) {
	const max = Math.max(1, ...rows.map((r) => r.requests));
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
								<span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">{compact(row.requests)}</span>
							</div>
							<div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
								<div style={{ width: `${(row.requests / max) * 100}%`, background: ACCENT }} />
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * A panel whose backing dataset failed (wrong guessed field name, or a genuinely missing scope)
 * says so instead of rendering a chart or number that looks like real, quiet data. Distinguishing
 * "unavailable" from "zero" is the whole point — see the note on AiGatewayDatasetStatus.
 */
function UnavailableNote({ status, label }: { status: DatasetStatus; label: string }) {
	if (status.available) return null;
	return (
		<p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
			{label} unavailable{status.reason ? `: ${status.reason}` : ""}.
		</p>
	);
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

	const granularity: AiGatewayGranularity = timeRange.minutes > 7 * 24 * 60 ? "daily" : "hourly";
	const { from, to } = timeRange.bounds();

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load]);

	const totals = result?.totals ?? EMPTY_TOTALS;
	const datasets = result?.datasets;

	return (
		<PageShell>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{granularity === "daily" ? "Daily buckets" : "Hourly buckets"}
				</span>
			</div>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard label="Requests" value={compact(totals.requests)} />
				<StatCard label="Tokens" value={compact(totals.tokensIn + totals.tokensOut)} hint={`${compact(totals.tokensIn)} in / ${compact(totals.tokensOut)} out`} />
				<div>
					<StatCard label="Error rate" value={formatRate(totals.errorRate)} />
					{datasets && <UnavailableNote status={datasets.errors} label="Errors" />}
				</div>
				<div>
					<StatCard label="Cache hit rate" value={formatRate(totals.cacheHitRate)} />
					{datasets && <UnavailableNote status={datasets.cache} label="Cache" />}
				</div>
			</StatGrid>

			<div>
				<StatCard label="Spend" value={formatCost(totals.cost)} hint="entered rates not required — Cloudflare-reported cost" />
				{datasets && <UnavailableNote status={datasets.spend} label="Spend" />}
			</div>

			<section className={`${CARD}`}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Requests over time</h2>
				<RequestsChart series={result?.series ?? []} granularity={result?.granularity ?? granularity} />
			</section>

			<div className="grid gap-4 lg:grid-cols-2">
				<BreakdownCard title="Gateways" rows={result?.byGateway ?? []} emptyText="No gateway traffic in this window." />
				<BreakdownCard title="Models / providers" rows={result?.byModel ?? []} emptyText="No model traffic in this window." />
			</div>

			<p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
				Aggregate only, account-scoped. Field names for these datasets are unverified against a live
				Cloudflare schema — see the note at the top of src/lib/ai-gateway.ts. A dataset that fails to
				load says so above rather than showing as quiet.
			</p>
		</PageShell>
	);
}

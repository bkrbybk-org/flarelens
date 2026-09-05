import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { AlertIcon, AppsIcon, GlobeIcon, KeyIcon, RefreshIcon } from "../../components/Icons";
import { ProgressBar } from "../../components/ProgressBar";
import { publishCacheSnapshot } from "../../lib/sectionSnapshot";
import { CountsLine, RatioBar, RuleCard } from "./RuleCard";
import { TrendChart } from "./TrendChart";
import { UrlTester, type TestResults } from "./UrlTester";
import { useCacheData } from "./useCacheData";

interface CachePageProps {
	session: Session;
	zoneId: string;
	timeRange: TimeRange;
	onAuthError: () => void;
}

/** Mirrors ALLOWED_RANGES in src/lib/cache-analysis.ts; anything else is rejected upstream. */
const ALLOWED_CACHE_HOURS = [24, 168, 720];

const RANGE_OPTIONS: [number, string][] = [
	[24, "Last 24 hours"],
	[168, "Last 7 days"],
	[720, "Last 30 days"],
];

const GRADE_COLORS: Record<string, string> = {
	A: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	B: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	C: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	D: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	F: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function CachePage({ session, zoneId, timeRange, onAuthError }: CachePageProps) {
	const cache = useCacheData(onAuthError);
	const { load } = cache;
	/**
	 * The analyzer only accepts 24h, 7d or 30d, so the shared window snaps to the largest of
	 * those it covers rather than being rejected server-side.
	 */
	const rangeHours = ALLOWED_CACHE_HOURS.reduce(
		(best, hours) => (timeRange.minutes >= hours * 60 ? hours : best),
		ALLOWED_CACHE_HOURS[0],
	);

	// Deep-linkable: #/cache?range=168

	// Results are stamped with the scope they were computed for; a scope change
	// invalidates them implicitly (no reset-in-effect needed).
	const scopeKey = `${zoneId}:${rangeHours}`;
	const [testRun, setTestRun] = useState<{ key: string; results: TestResults } | null>(null);
	const testResults = testRun && testRun.key === scopeKey ? testRun.results : null;

	useEffect(() => {
		if (zoneId) {
			load(session.token, zoneId, rangeHours);
		}
	}, [session.token, zoneId, rangeHours, load]);

	const data = cache.data;

	// Publish the latest load for the Findings page, which reads a snapshot
	// rather than duplicating this fetch (see lib/sectionSnapshot.ts).
	useEffect(() => {
		if (data) publishCacheSnapshot(session.accountId, data);
	}, [data, session.accountId]);

	const stats = useMemo(() => {
		if (!data) return null;
		const active = data.rules.filter((r) => r.enabled).length;
		let hits = 0;
		let total = 0;
		const add = (a: { hits: number; misses: number; bypass: number }) => {
			hits += a.hits;
			total += a.hits + a.misses + a.bypass;
		};
		for (const r of data.rules) add(r.analytics);
		if (data.unattributed) add(data.unattributed.analytics);
		return {
			rules: data.rules.length,
			active,
			hitRatio: total ? Math.round((hits / total) * 1000) / 10 : 0,
			analyzed: total,
		};
	}, [data]);

	if (!zoneId) {
		return (
			<div className="flex h-full items-center justify-center p-6">
				<div className="rounded-2xl border border-zinc-200 bg-white px-8 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900">
					<GlobeIcon size={28} className="mx-auto mb-3 text-zinc-400" />
					<h2 className="text-base font-semibold">Select a zone</h2>
					<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
						Cache rules are zone-scoped — pick a zone from the selector in the top bar.
					</p>
				</div>
			</div>
		);
	}

	const statCards = stats
		? [
			{ label: "Cache rules", value: String(stats.rules), icon: AppsIcon, cls: "bg-cf/15 text-cf" },
			{ label: "Active rules", value: String(stats.active), icon: KeyIcon, cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
			{ label: "Overall hit ratio", value: `${stats.hitRatio.toFixed(1)}%`, icon: GlobeIcon, cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
			{ label: "Analyzed requests", value: stats.analyzed.toLocaleString(), icon: RefreshIcon, cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
		]
		: [];

	return (
		<div className="h-full overflow-y-auto">
			<div className="space-y-4 p-4 md:p-6">
				{cache.progress.running && <ProgressBar percent={cache.progress.percent} />}

				{cache.error && (
					<div role="alert" className="rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
						{cache.error}
					</div>
				)}

				{/* Controls */}
				<div className="flex flex-wrap items-center gap-2">
					{/* Cloudflare's cache analytics only answers for 24h, 7d or 30d, so the shared
					    window snaps to one of those and the page says which. */}
					<span className="rounded-lg border border-zinc-200 px-2.5 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
						{RANGE_OPTIONS.find(([value]) => value === rangeHours)?.[1] ?? `Last ${rangeHours}h`}
					</span>
					<button
						type="button"
						onClick={() => load(session.token, zoneId, rangeHours)}
						disabled={cache.loading}
						className="flex items-center gap-2 rounded-lg bg-cf px-3 py-2 text-sm font-medium text-white transition hover:bg-cf-hover disabled:opacity-50"
					>
						<RefreshIcon size={14} className={cache.loading ? "animate-spin" : undefined} />
						Refresh
					</button>
					{data && (
						<span className="text-xs text-zinc-500 dark:text-zinc-400">
							Zone: <span className="font-medium">{data.zoneName}</span>
						</span>
					)}
				</div>

				{data && (
					<>
						{data.analyticsSource !== "path-graphql" && (
							<div className="flex items-center gap-2 rounded-xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
								<AlertIcon size={16} className="shrink-0" />
								<span>
									{data.analyticsSource === "mock"
										? `Showing simulated data — real analytics unavailable: ${data.analyticsReason}.`
										: `No traffic data: ${data.analyticsReason}.`}
								</span>
							</div>
						)}

						{/* Stats + health */}
						<div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
							{statCards.map(({ label, value, icon: Icon, cls }) => (
								<div key={label} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
									<span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${cls}`}>
										<Icon size={18} />
									</span>
									<div className="min-w-0 leading-tight">
										<div className="text-xl font-semibold tabular-nums">{value}</div>
										<div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
									</div>
								</div>
							))}
							{data.health && (
								<div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
									<span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg font-bold ${GRADE_COLORS[data.health.grade] || "bg-zinc-500/10 text-zinc-500"}`}>
										{data.health.grade}
									</span>
									<div className="min-w-0 leading-tight">
										<div className="text-xl font-semibold tabular-nums">{data.health.ratio.toFixed(1)}%</div>
										<div className="truncate text-xs text-zinc-500 dark:text-zinc-400">Cache health</div>
									</div>
								</div>
							)}
						</div>

						{data.zoneTotals && (
							<p className="text-xs text-zinc-500 dark:text-zinc-400">
								Sampled analytics cover {data.zoneTotals.coveragePct.toFixed(1)}% of {data.zoneTotals.requests.toLocaleString()} zone requests in this window.
							</p>
						)}

						{data.versioning.enabled && (
							<div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
								<h2 className="mb-2 text-sm font-semibold">Version Management</h2>
								<div className="flex flex-wrap gap-2 text-xs">
									{data.versioning.environments.map((env) => (
										<span key={env.name} className="rounded-md bg-zinc-200/70 px-2 py-1 font-medium text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300">
											{env.name}{env.version !== null ? ` → v${env.version}` : ""}
										</span>
									))}
								</div>
								{data.versioning.versionZones.length > 0 && (
									<p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
										{data.versioning.versionZones.length} sibling version zone{data.versioning.versionZones.length === 1 ? "" : "s"} share this zone name — switch zones in the top bar to inspect a specific version.
									</p>
								)}
							</div>
						)}

						{data.timeseries && data.timeseries.length > 0 && (
							<TrendChart buckets={data.timeseries} rangeHours={data.rangeHours} />
						)}

						{data.insights.length > 0 && (
							<div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
								<h2 className="mb-2 text-sm font-semibold">Insights</h2>
								<ul className="space-y-1.5">
									{data.insights.map((insight, i) => (
										<li key={i} className="flex items-start gap-2 text-sm">
											<span className={insight.severity === "warn" ? "mt-0.5 shrink-0 text-amber-500" : "mt-0.5 shrink-0 text-sky-500"}>
												<AlertIcon size={14} />
											</span>
											<span className="text-zinc-700 dark:text-zinc-300">{insight.message}</span>
										</li>
									))}
								</ul>
							</div>
						)}

						{data.rules.length > 0 && (
							<UrlTester
								rules={data.rules}
								hosts={data.hosts}
								onResults={(results) => setTestRun(results ? { key: scopeKey, results } : null)}
							/>
						)}

						<div className="space-y-3">
							{data.rules.length === 0 ? (
								<p className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
									This zone has no cache rules configured.
								</p>
							) : (
								data.rules.map((rule, i) => (
									<RuleCard
										key={rule.id || i}
										rule={rule}
										index={i}
										highlight={
											!testResults
												? null
												: testResults.winnerId === rule.id
													? "winner"
													: testResults.outcomes[rule.id] === "matched"
														? "matched"
														: testResults.outcomes[rule.id] === "unknown"
															? "unknown"
															: null
										}
									/>
								))
							)}
						</div>

						{data.unattributed && (
							<div className="rounded-xl border border-dashed border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
								<div className="mb-2 flex items-center gap-2">
									<span className="font-medium">Unattributed traffic</span>
									<span className="text-xs text-zinc-500 dark:text-zinc-400">
										{data.unattributed.mixed
											? "no path-evaluable rule matched (includes traffic from unattributable rules)"
											: "matched no cache rule — zone default behavior applies"}
									</span>
								</div>
								<div className="space-y-1.5">
									<RatioBar analytics={data.unattributed.analytics} />
									<CountsLine analytics={data.unattributed.analytics} />
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

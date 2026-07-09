import type { CacheRule, RuleAnalytics, TopUrl } from "./types";

function settingChips(rule: CacheRule): string[] {
	const s = rule.settings;
	const chips: string[] = [];
	if (s.cache === true) chips.push("Cache eligible");
	if (s.cache === false) chips.push("Bypass cache");
	if (s.edgeTtl) chips.push(`Edge TTL: ${s.edgeTtl}`);
	if (s.browserTtl) chips.push(`Browser TTL: ${s.browserTtl}`);
	if (s.customCacheKey) chips.push("Custom cache key");
	if (s.serveStale) chips.push("Serve stale");
	if (s.respectStrongEtags) chips.push("Strong ETags");
	return chips;
}

export function RatioBar({ analytics }: { analytics: RuleAnalytics }) {
	const total = analytics.hits + analytics.misses + analytics.bypass;
	if (!total) return null;
	const pct = (n: number) => (n / total) * 100;
	return (
		<div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="img" aria-label={`Hit ratio ${analytics.hitRatio}%`}>
			<div className="bg-emerald-500" style={{ width: `${pct(analytics.hits)}%` }} />
			<div className="bg-amber-500" style={{ width: `${pct(analytics.misses)}%` }} />
			<div className="bg-zinc-400 dark:bg-zinc-600" style={{ width: `${pct(analytics.bypass)}%` }} />
		</div>
	);
}

export function CountsLine({ analytics }: { analytics: RuleAnalytics }) {
	const total = analytics.hits + analytics.misses + analytics.bypass;
	return (
		<div className="flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400">
			<span><span className="font-medium text-emerald-600 dark:text-emerald-400">{analytics.hits.toLocaleString()}</span> served</span>
			<span><span className="font-medium text-amber-600 dark:text-amber-400">{analytics.misses.toLocaleString()}</span> origin</span>
			<span><span className="font-medium">{analytics.bypass.toLocaleString()}</span> bypass/dynamic</span>
			<span>{total.toLocaleString()} total · <span className="font-medium">{analytics.hitRatio.toFixed(1)}%</span> hit ratio</span>
		</div>
	);
}

function TopUrlList({ urls }: { urls: TopUrl[] }) {
	if (!urls.length) return null;
	return (
		<details className="mt-2">
			<summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
				Top URLs
			</summary>
			<ul className="mt-1.5 space-y-1 text-xs">
				{urls.map((u) => (
					<li key={u.url} className="flex items-center justify-between gap-3">
						<span className="min-w-0 truncate" title={u.url}>{u.url}</span>
						<span className="shrink-0 text-zinc-500 dark:text-zinc-400">
							{u.requests.toLocaleString()} req · {u.hitRatio.toFixed(1)}%
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

export function RuleCard({ rule, index, highlight }: { rule: CacheRule; index: number; highlight?: "winner" | "matched" | "unknown" | null }) {
	const ring =
		highlight === "winner"
			? "ring-2 ring-emerald-500"
			: highlight === "matched"
				? "ring-1 ring-cf/60"
				: highlight === "unknown"
					? "ring-1 ring-amber-500/60"
					: "";
	return (
		<div className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${ring}`}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-semibold text-zinc-400">#{index + 1}</span>
				<span className="min-w-0 flex-1 truncate font-medium">{rule.description || "(no description)"}</span>
				{highlight === "winner" && (
					<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">Winner</span>
				)}
				{highlight === "unknown" && (
					<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">Unknown</span>
				)}
				<span
					className={
						rule.enabled
							? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400"
							: "rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
					}
				>
					{rule.enabled ? "Active" : "Paused"}
				</span>
			</div>

			<code className="mt-2 block max-h-20 overflow-auto rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs break-all dark:bg-zinc-950">
				{rule.expression || "true (matches everything)"}
			</code>

			{settingChips(rule).length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{settingChips(rule).map((chip) => (
						<span key={chip} className="rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300">
							{chip}
						</span>
					))}
				</div>
			)}

			{rule.attribution === "unattributable" ? (
				<p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
					Traffic not attributable from path analytics — expression uses: {rule.attributionNote}. Its traffic appears in the unattributed row.
				</p>
			) : (
				<div className="mt-3 space-y-1.5">
					<RatioBar analytics={rule.analytics} />
					<CountsLine analytics={rule.analytics} />
					<TopUrlList urls={rule.topUrls || []} />
				</div>
			)}
		</div>
	);
}

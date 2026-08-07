import { useEffect, useMemo, useState } from "react";
import { useHashSyncedState } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import { aggregateRulesets, countEventsByActions } from "../../lib/waf/aggregate";
import { AUTO_REFRESH_OPTIONS, DEFAULT_LOOKBACK_MINUTES, EVENT_LIMIT, LOOKBACK_OPTIONS } from "../../lib/waf/constants";
import { relativeTime } from "../../lib/waf/format";
import { publishWafSnapshot } from "../../lib/sectionSnapshot";
import { AlertIcon, AppsIcon, KeyIcon, RefreshIcon, SearchIcon, ShieldIcon, UsersIcon } from "../../components/Icons";
import { ProgressBar } from "../../components/ProgressBar";
import { EventGraph } from "./EventGraph";
import { RuleDrawer, type DrawerRule } from "./RuleDrawer";
import { RulesetTable } from "./RulesetTable";
import { RulesReview } from "./RulesReview";
import { useWafData } from "./useWafData";

interface WafPageProps {
	session: Session;
	zoneId: string;
	onAuthError: () => void;
}

type Tab = "overview" | "rules";

export function WafPage({ session, zoneId, onAuthError }: WafPageProps) {
	const waf = useWafData(onAuthError);
	const { load } = waf;
	const [minutes, setMinutes] = useState(DEFAULT_LOOKBACK_MINUTES);
	const [autoRefresh, setAutoRefresh] = useState(0);
	const [tab, setTab] = useState<Tab>("overview");
	const [globalSearch, setGlobalSearch] = useState("");
	const [lastRefreshed, setLastRefreshed] = useState<string>("");
	const [drawerRule, setDrawerRule] = useState<DrawerRule | null>(null);

	// Deep-linkable state: #/waf?lookback=1440&tab=rules
	useHashSyncedState("lookback", String(minutes), (v) => {
		const n = Number(v);
		if (LOOKBACK_OPTIONS.some(([value]) => value === n)) setMinutes(n);
	});
	useHashSyncedState("tab", tab, (v) => {
		if (v === "overview" || v === "rules") setTab(v);
	});

	useEffect(() => {
		load(session.token, session.accountId, zoneId, minutes).then(() => setLastRefreshed(new Date().toISOString()));
	}, [session.token, session.accountId, zoneId, minutes, load]);

	useEffect(() => {
		if (!autoRefresh) return;
		const timer = setInterval(() => {
			load(session.token, session.accountId, zoneId, minutes).then(() => setLastRefreshed(new Date().toISOString()));
		}, autoRefresh);
		return () => clearInterval(timer);
	}, [autoRefresh, session.token, session.accountId, zoneId, minutes, load]);

	// Publish the latest load for the Findings page, which reads a snapshot
	// rather than duplicating this fetch (see lib/sectionSnapshot.ts).
	useEffect(() => {
		if (waf.loaded) publishWafSnapshot({ events: waf.events, ruleMeta: waf.ruleMeta });
	}, [waf.loaded, waf.events, waf.ruleMeta]);

	const rulesetRows = useMemo(() => aggregateRulesets(waf.events, waf.ruleMeta), [waf.events, waf.ruleMeta]);

	const kpis = useMemo(() => ({
		total: waf.events.length,
		blocked: countEventsByActions(waf.events, ["block"]),
		challenged: countEventsByActions(waf.events, ["challenge", "managed_challenge", "js_challenge"]),
		logged: countEventsByActions(waf.events, ["log"]),
		rulesets: rulesetRows.length,
	}), [waf.events, rulesetRows]);

	const selectCls =
		"rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900";

	const kpiCards = [
		{ label: "Total events", value: kpis.total, icon: AppsIcon, cls: "bg-cf/15 text-cf" },
		{ label: "Blocked", value: kpis.blocked, icon: ShieldIcon, cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
		{ label: "Challenged", value: kpis.challenged, icon: KeyIcon, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
		{ label: "Logged", value: kpis.logged, icon: SearchIcon, cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
		{ label: "Rulesets firing", value: kpis.rulesets, icon: UsersIcon, cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
	];

	return (
		<div className="h-full overflow-y-auto">
			<div className="space-y-4 p-4 md:p-6">
				{waf.progress.running && <ProgressBar percent={waf.progress.percent} />}

				{waf.error && (
					<div role="alert" className="rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
						{waf.error}
					</div>
				)}

				{waf.diagnostics?.truncated && (
					<div className="flex items-center gap-2 rounded-xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
						<AlertIcon size={16} />
						Event window truncated at ~{EVENT_LIMIT.toLocaleString()} rows — narrow the lookback for complete data.
					</div>
				)}

				{/* Controls */}
				<div className="flex flex-wrap items-center gap-2">
					<select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Lookback window" className={selectCls}>
						{LOOKBACK_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
					</select>
					<select value={autoRefresh} onChange={(e) => setAutoRefresh(Number(e.target.value))} aria-label="Auto refresh" className={selectCls}>
						{AUTO_REFRESH_OPTIONS.map(([value, label]) => <option key={value} value={value}>Auto: {label}</option>)}
					</select>
					<button
						type="button"
						onClick={() => load(session.token, session.accountId, zoneId, minutes).then(() => setLastRefreshed(new Date().toISOString()))}
						disabled={waf.loading}
						className="flex items-center gap-2 rounded-lg bg-cf px-3 py-2 text-sm font-medium text-white transition hover:bg-cf-hover disabled:opacity-50"
					>
						<RefreshIcon size={14} className={waf.loading ? "animate-spin" : undefined} />
						Refresh
					</button>
					{lastRefreshed && (
						<span className="text-xs text-zinc-500 dark:text-zinc-400">Updated {relativeTime(lastRefreshed)}</span>
					)}
				</div>

				{/* KPI cards */}
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
					{kpiCards.map(({ label, value, icon: Icon, cls }) => (
						<div key={label} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
							<span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${cls}`}>
								<Icon size={18} />
							</span>
							<div className="min-w-0 leading-tight">
								<div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
								<div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
							</div>
						</div>
					))}
				</div>

				{/* Tabs */}
				<div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist">
					{([["overview", "Overview"], ["rules", "Rules Review"]] as [Tab, string][]).map(([id, label]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							onClick={() => setTab(id)}
							className={
								tab === id
									? "border-b-2 border-cf px-4 py-2 text-sm font-medium text-cf"
									: "border-b-2 border-transparent px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
							}
						>
							{label}
						</button>
					))}
				</div>

				{tab === "overview" ? (
					<>
						<EventGraph events={waf.events} window={waf.window} />
						<div className="relative">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
							<input
								type="search"
								value={globalSearch}
								onChange={(e) => setGlobalSearch(e.target.value)}
								placeholder="Search rulesets, rules, hosts…"
								className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</div>
						<RulesetTable rows={rulesetRows} globalSearch={globalSearch} window={waf.window} onSelectRule={setDrawerRule} />
					</>
				) : (
					<RulesReview events={waf.events} ruleMeta={waf.ruleMeta} window={waf.window} onSelectRule={setDrawerRule} />
				)}

				<RuleDrawer
					rule={drawerRule}
					events={waf.events}
					ruleMeta={waf.ruleMeta}
					window={waf.window}
					onClose={() => setDrawerRule(null)}
				/>
			</div>
		</div>
	);
}

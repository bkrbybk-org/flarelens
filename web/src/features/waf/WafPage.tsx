import { useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { StatCard, StatGrid } from "../../components/StatCard";
import { ALERT_ERROR, ALERT_WARN, INPUT, SEARCH_INPUT } from "../../lib/ui";
import { useHashSyncedState } from "../../hooks/useHashParams";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { aggregateRulesets, countEventsByActions } from "../../lib/waf/aggregate";
import { AUTO_REFRESH_OPTIONS, EVENT_LIMIT, LOOKBACK_OPTIONS } from "../../lib/waf/constants";
import { relativeTime } from "../../lib/waf/format";
import { publishWafSnapshot } from "../../lib/sectionSnapshot";
import { AlertIcon, AppsIcon, KeyIcon, SearchIcon, ShieldIcon, UsersIcon } from "../../components/Icons";
import { EventGraph } from "./EventGraph";
import { RuleDrawer, type DrawerRule } from "./RuleDrawer";
import { RulesetTable } from "./RulesetTable";
import { RulesReview } from "./RulesReview";
import { useWafData } from "./useWafData";

interface WafPageProps {
	session: Session;
	timeRange: TimeRange;
	zoneId: string;
	onAuthError: () => void;
}

type Tab = "overview" | "rules";

const SEVEN_DAYS_MINUTES = 7 * 24 * 60;

/**
 * Measured on this account 2026-09-12: a 30-day window returned fewer WAF events (5,388) than a
 * 7-day window (18,440). Past 7 days the event log is a sparse, non-uniform sample rather than
 * more data, so counts from it are not comparable with a narrower window. Null at or under 7 days.
 */
export function wideWindowWarning(minutes: number): string | null {
	if (minutes <= SEVEN_DAYS_MINUTES) return null;
	return "This window is wider than 7 days. On this account a 30-day window returned fewer events than a 7-day window (5,388 vs 18,440, measured 2026-09-12) — beyond 7 days the event log is a sparse sample, not a complete count. Don't read trends from event counts at this window size.";
}

export function WafPage({ session, zoneId, timeRange, onAuthError }: WafPageProps) {
	const waf = useWafData(onAuthError);
	const { load } = waf;
	// The worker clamps the lookback to [5, 43200]; the shared window is already inside that,
	// so it maps straight through.
	const minutes = timeRange.minutes;
	const [autoRefresh, setAutoRefresh] = useState(0);
	const [tab, setTab] = useState<Tab>("overview");
	const [globalSearch, setGlobalSearch] = useState("");
	const [lastRefreshed, setLastRefreshed] = useState<string>("");
	const [drawerRule, setDrawerRule] = useState<DrawerRule | null>(null);

	// Deep-linkable state: #/waf?lookback=1440&tab=rules
	// This page only exists while route === "waf" (App mounts/unmounts it), so a literal
	// route is fine — there's no cross-route case to key adoption on here.
	useHashSyncedState(
		"tab",
		tab,
		(v) => {
			if (v === "overview" || v === "rules") setTab(v);
		},
		"waf",
	);

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
		if (waf.loaded) publishWafSnapshot(session.accountId, { events: waf.events, ruleMeta: waf.ruleMeta });
	}, [waf.loaded, waf.events, waf.ruleMeta, session.accountId]);

	const rulesetRows = useMemo(() => aggregateRulesets(waf.events, waf.ruleMeta), [waf.events, waf.ruleMeta]);

	const kpis = useMemo(() => ({
		total: waf.events.length,
		blocked: countEventsByActions(waf.events, ["block"]),
		challenged: countEventsByActions(waf.events, ["challenge", "managed_challenge", "js_challenge"]),
		logged: countEventsByActions(waf.events, ["log"]),
		rulesets: rulesetRows.length,
	}), [waf.events, rulesetRows]);

	const selectCls =
		INPUT;

	const kpiCards = [
		{ label: "Total events", value: kpis.total, icon: AppsIcon, cls: "bg-cf/15 text-cf" },
		{ label: "Blocked", value: kpis.blocked, icon: ShieldIcon, cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
		{ label: "Challenged", value: kpis.challenged, icon: KeyIcon, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
		{ label: "Logged", value: kpis.logged, icon: SearchIcon, cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
		{ label: "Rulesets firing", value: kpis.rulesets, icon: UsersIcon, cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
	];

	const refresh = useCallback(
		() => void load(session.token, session.accountId, zoneId, minutes).then(() => setLastRefreshed(new Date().toISOString())),
		[load, session.token, session.accountId, zoneId, minutes],
	);
	useSectionRefresh(refresh, waf.loading);

	const wideWindowNote = wideWindowWarning(minutes);

	return (
		<PageShell progress={waf.progress}>

			{waf.error && (
				<div role="alert" className={ALERT_ERROR}>
					{waf.error}
				</div>
			)}

			{waf.diagnostics?.truncated && (
				<div className={`flex items-center gap-2 ${ALERT_WARN}`}>
					<AlertIcon size={16} />
					Event window truncated at ~{EVENT_LIMIT.toLocaleString()} rows — narrow the lookback for complete data.
				</div>
			)}

			{wideWindowNote && (
				<div role="status" className={ALERT_WARN}>
					{wideWindowNote}
				</div>
			)}

			{/* Controls */}
			<div className="flex flex-wrap items-center gap-2">
				{/* Lookback follows the shared window in the top bar. */}
				<span className="rounded-lg border border-zinc-200 px-2.5 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
					{LOOKBACK_OPTIONS.find(([value]) => value === minutes)?.[1] ?? `Last ${minutes} min`}
				</span>
				<select value={autoRefresh} onChange={(e) => setAutoRefresh(Number(e.target.value))} aria-label="Auto refresh" className={selectCls}>
					{AUTO_REFRESH_OPTIONS.map(([value, label]) => <option key={value} value={value}>Auto: {label}</option>)}
				</select>
				{lastRefreshed && (
					<span className="text-xs text-zinc-500 dark:text-zinc-400">Updated {relativeTime(lastRefreshed)}</span>
				)}
			</div>

			{/* KPI cards */}
			<StatGrid cols={5}>
				{kpiCards.map(({ label, value, icon, cls }) => (
					<StatCard key={label} label={label} value={value} icon={icon} iconClass={cls} />
				))}
			</StatGrid>

			{/* Tabs */}
			<Tabs
				label="WAF views"
				idPrefix="waf"
				active={tab}
				onChange={setTab}
				tabs={[
					{ id: "overview", label: "Overview" },
					{ id: "rules", label: "Rules Review" },
				]}
			/>

			{tab === "overview" ? (
				<TabPanel id="overview" idPrefix="waf">
					<div className="space-y-4">
						<EventGraph events={waf.events} window={waf.window} />
						<div className="relative">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
							<input
								type="search"
								value={globalSearch}
								onChange={(e) => setGlobalSearch(e.target.value)}
								placeholder="Search rulesets, rules, hosts…"
								className={SEARCH_INPUT}
							/>
						</div>
						<RulesetTable rows={rulesetRows} globalSearch={globalSearch} window={waf.window} onSelectRule={setDrawerRule} />
					</div>
				</TabPanel>
			) : (
				<TabPanel id="rules" idPrefix="waf">
					<RulesReview events={waf.events} ruleMeta={waf.ruleMeta} window={waf.window} onSelectRule={setDrawerRule} />
				</TabPanel>
			)}

			<RuleDrawer
				rule={drawerRule}
				events={waf.events}
				ruleMeta={waf.ruleMeta}
				window={waf.window}
				onClose={() => setDrawerRule(null)}
			/>
		</PageShell>
	);
}

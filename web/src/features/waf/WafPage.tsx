import { useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { StatCard, StatGrid } from "../../components/StatCard";
import { ALERT_ERROR, ALERT_WARN, CARD, INPUT, SEARCH_INPUT, SECTION_TITLE } from "../../lib/ui";
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
 * The event rows are adaptively sampled, more heavily the wider the window: on this account a
 * 30-day window once returned fewer rows (5,388) than a 7-day one (18,440). The headline counts and
 * the chart now come from the groups dataset's full counts and are unaffected; what stays sampled
 * is the per-rule breakdown, which is built from the rows. So the warning is only needed — and only
 * about the rule tables — past 7 days. Null at or under 7 days.
 */
export function wideWindowWarning(minutes: number): string | null {
	if (minutes <= SEVEN_DAYS_MINUTES) return null;
	return "Past 7 days the per-rule tables are built from a sparse sample of events (a 30-day window once returned fewer rows than a 7-day one). The totals and the chart above use Cloudflare's full counts and are not affected — compare rules within this window, not across window sizes.";
}

/** Actions the headline leaves out, with a readable name. */
const OTHER_ACTIONS: Record<string, string> = {
	skip: "skip",
	link_maze_injected: "AI Labyrinth links injected",
	link_maze_visited: "AI Labyrinth visits",
};

/** Where WAF events come from, by full count. Country codes as Cloudflare reports them. */
function TopCountries({ countries, total }: { countries: { country: string; count: number }[]; total: number }) {
	const max = Math.max(1, ...countries.map((c) => c.count));
	return (
		<section className={CARD} aria-label="Top countries">
			<h2 className={`mb-3 ${SECTION_TITLE}`}>Top countries</h2>
			<ul className="space-y-1.5 text-sm">
				{countries.map(({ country, count }) => (
					<li key={country} className="flex items-center gap-3">
						<span className="w-10 shrink-0 font-mono text-xs">{country}</span>
						<span className="h-2 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
							<span className="block h-2 rounded bg-cf/70" style={{ width: `${(count / max) * 100}%` }} />
						</span>
						<span className="w-24 shrink-0 text-right tabular-nums">
							{count.toLocaleString()}
							<span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">{total ? `${Math.round((count / total) * 100)}%` : ""}</span>
						</span>
					</li>
				))}
			</ul>
		</section>
	);
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

	// Full counts when the groups dataset answered; counting sampled rows only as a stated fallback.
	const agg = waf.aggregates;
	const kpis = useMemo(() => {
		const sum = (actions: string[]) => actions.reduce((n, a) => n + (agg?.byAction[a] ?? 0), 0);
		return agg
			? {
				total: agg.total,
				blocked: sum(["block"]),
				challenged: sum(["challenge", "managed_challenge", "js_challenge"]),
				logged: sum(["log"]),
				rulesets: rulesetRows.length,
			}
			: {
				total: waf.events.length,
				blocked: countEventsByActions(waf.events, ["block"]),
				challenged: countEventsByActions(waf.events, ["challenge", "managed_challenge", "js_challenge"]),
				logged: countEventsByActions(waf.events, ["log"]),
				rulesets: rulesetRows.length,
			};
	}, [agg, waf.events, rulesetRows]);
	const otherActions = agg
		? Object.entries(agg.byAction).filter(([action, count]) => count > 0 && !["block", "challenge", "managed_challenge", "js_challenge", "log"].includes(action))
		: [];

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
		// Sync is an explicit "show me what is there now", so it also bypasses the ruleset cache.
		() => void load(session.token, session.accountId, zoneId, minutes, true).then(() => setLastRefreshed(new Date().toISOString())),
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
			{waf.loaded && (
				<p className="text-xs text-zinc-500 dark:text-zinc-400">
					{agg ? (
						<>
							Totals and the chart are Cloudflare's full counts. The rule tables below are built from a sample of{" "}
							{waf.events.length.toLocaleString()} events
							{agg.sampleInterval && agg.sampleInterval > 1.05 ? ` (each sampled event stands for about ${agg.sampleInterval.toFixed(1)} on average)` : ""}.
							{otherActions.length > 0 && (
								<> Not counted above: {otherActions.map(([action, count]) => `${count.toLocaleString()} ${OTHER_ACTIONS[action] ?? action}`).join(", ")}.</>
							)}
						</>
					) : (
						<>
							Full counts could not be read{waf.aggregatesError ? ` (${waf.aggregatesError})` : ""}, so every number here counts sampled events and
							understates real traffic.
						</>
					)}
				</p>
			)}

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
						<EventGraph events={waf.events} window={waf.window} series={agg?.series} bucket={agg?.bucket} />
						{agg && agg.countries.length > 0 && <TopCountries countries={agg.countries} total={agg.total} />}
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

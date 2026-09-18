import { useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { BADGE, BADGE_NEUTRAL, BTN_SECONDARY, FOCUS_RING, INPUT, SEARCH_INPUT } from "../../lib/ui";
import { actionDrift, aggregateRules, groupRulesByRuleset, topEntries, type RuleGroup } from "../../lib/waf/aggregate";
import { relativeTime, titleCase } from "../../lib/waf/format";
import type { FirewallEvent, RuleMetaMap, RuleReviewRow } from "../../lib/waf/types";
import { ChevronDownIcon, SearchIcon } from "../../components/Icons";
import { ActionBadges, RuleLevelBadge, RuleTypeBadge, Sparkline } from "./bars";
import { EvaluationOrder } from "./EvaluationOrder";

interface RulesReviewProps {
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
	window: { since: number; until: number } | null;
	onSelectRule: (rule: { id: string; name: string; configuredAction?: string; lastSeen?: string }) => void;
}

/** Rules shown per ruleset before "Show all" — a managed ruleset can carry hundreds. */
const GROUP_PREVIEW = 10;

type StatusFilter = "" | "enabled" | "disabled" | "active" | "idle";

export function RulesReview({ events, ruleMeta, window: win, onSelectRule }: RulesReviewProps) {
	const [search, setSearch] = useState("");
	const [type, setType] = useState("");
	const [level, setLevel] = useState("");
	const [status, setStatus] = useState<StatusFilter>("");
	const [view, setView] = useState<"ruleset" | "order">("ruleset");
	// Collapsed groups by key. Everything starts open: the grouping is for reading, not hiding.
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

	const rows = useMemo(() => aggregateRules(events, ruleMeta), [events, ruleMeta]);

	const summary = useMemo(() => ({
		known: rows.length,
		disabled: rows.filter((r) => !r.enabled).length,
		enabledIdle: rows.filter((r) => r.enabled && !r.total).length,
		drift: rows.filter((r) => actionDrift(r)).length,
	}), [rows]);

	const matches = useMemo(() => {
		const q = search.trim().toLowerCase();
		return (row: RuleReviewRow) => {
			if (type && row.type !== type) return false;
			if (level && row.level !== level) return false;
			if (status === "enabled" && !row.enabled) return false;
			if (status === "disabled" && row.enabled) return false;
			if (status === "active" && !row.total) return false;
			if (status === "idle" && row.total) return false;
			if (!q) return true;
			const haystack = [
				row.name, row.id, row.ruleset, row.configuredAction, row.expression,
				Object.keys(row.actions).join(" "),
				[...row.hosts.keys()].join(" "),
				[...row.paths.keys()].join(" "),
			].join(" ").toLowerCase();
			return haystack.includes(q);
		};
	}, [search, type, level, status]);

	const filtered = useMemo(() => rows.filter(matches), [rows, matches]);

	const groups = useMemo(() => groupRulesByRuleset(filtered), [filtered]);

	const toggleGroup = (key: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));

	const selectCls =
		INPUT;

	const chips = [
		{ label: "Rules known", value: summary.known, cls: "" },
		{ label: "Disabled", value: summary.disabled, cls: summary.disabled ? "text-amber-600 dark:text-amber-400" : "" },
		{ label: "Enabled, no traffic", value: summary.enabledIdle, cls: "" },
		{ label: "Action drift", value: summary.drift, cls: summary.drift ? "text-amber-600 dark:text-amber-400" : "" },
	];

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-2">
				{chips.map(({ label, value, cls }) => (
					<span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
						<span className={`font-semibold tabular-nums ${cls}`}>{value.toLocaleString()}</span>
						<span className="text-zinc-500 dark:text-zinc-400">{label}</span>
					</span>
				))}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-56">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search rules, expressions, hosts, paths…"
						className={SEARCH_INPUT}
					/>
				</div>
				<select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type" className={selectCls}>
					<option value="">All types</option>
					<option value="managed">Managed</option>
					<option value="custom">Custom</option>
				</select>
				<select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter by level" className={selectCls}>
					<option value="">All levels</option>
					<option value="account">Account</option>
					<option value="zone">Zone</option>
				</select>
				<select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Filter by status" className={selectCls}>
					<option value="">All statuses</option>
					<option value="enabled">Enabled</option>
					<option value="disabled">Disabled</option>
					<option value="active">With traffic</option>
					<option value="idle">No traffic</option>
				</select>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
				<div role="group" aria-label="Arrange rules" className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
					{([["ruleset", "By ruleset"], ["order", "Evaluation order"]] as const).map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={view === id}
							onClick={() => setView(id)}
							className={`rounded-md px-3 py-1 text-xs font-medium ${FOCUS_RING} ${
								view === id ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-300"
							}`}
						>
							{label}
						</button>
					))}
				</div>
				{view === "ruleset" && groups.length > 0 && (
					<div className="flex items-center gap-2">
						<span className="text-zinc-500 dark:text-zinc-400">
							{filtered.length.toLocaleString()} rules in {groups.length.toLocaleString()} rulesets
						</span>
						<button
							type="button"
							className={BTN_SECONDARY}
							onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)))}
						>
							{allCollapsed ? "Expand all" : "Collapse all"}
						</button>
					</div>
				)}
			</div>
			{view === "order" ? (
				<EvaluationOrder ruleMeta={ruleMeta} rows={rows} visible={matches} onSelect={onSelectRule} />
			) : groups.length === 0 ? (
				<EmptyState title="No matching rules" hint="Try a different search or filter." />
			) : (
				<div className="space-y-4">
					{groups.map((group) => (
						<RulesetGroup
							// A filter change can empty and refill a group; remounting resets "Show all".
							key={`${group.key}|${search}|${type}|${level}|${status}`}
							group={group}
							open={!collapsed.has(group.key)}
							onToggle={() => toggleGroup(group.key)}
							win={win}
							onSelect={onSelectRule}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function RulesetGroup({ group, open, onToggle, win, onSelect }: {
	group: RuleGroup;
	open: boolean;
	onToggle: () => void;
	win: { since: number; until: number } | null;
	onSelect: (rule: { id: string; name: string; configuredAction?: string; lastSeen?: string }) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const visible = showAll ? group.rules : group.rules.slice(0, GROUP_PREVIEW);
	const panelId = `waf-ruleset-${group.key || "unattributed"}`;
	return (
		<section aria-label={group.zone ? `${group.name} (${group.zone})` : group.name}>
			<h3>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					aria-controls={panelId}
					className={`flex w-full flex-wrap items-center gap-2 rounded-lg px-1 py-1.5 text-left ${FOCUS_RING}`}
				>
					<ChevronDownIcon size={16} className={`shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${open ? "" : "-rotate-90"}`} />
					<span className="font-semibold">{group.name}</span>
					{group.zone && <span className="text-sm text-zinc-500 dark:text-zinc-400">{group.zone}</span>}
					{group.type && <RuleTypeBadge type={group.type} />}
					{group.level && <RuleLevelBadge level={group.level} />}
					<span className="text-xs text-zinc-500 dark:text-zinc-400">
						{group.rules.length.toLocaleString()} {group.rules.length === 1 ? "rule" : "rules"}
					</span>
					{group.disabled > 0 && <span className={BADGE_NEUTRAL}>{group.disabled} disabled</span>}
					{group.drift > 0 && (
						<span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`}>{group.drift} drift</span>
					)}
					<span className="ml-auto text-sm font-semibold tabular-nums">
						{group.total.toLocaleString()} <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">events</span>
					</span>
				</button>
			</h3>
			{open && (
				<div id={panelId} className="mt-2 space-y-3 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
					{visible.map((row) => <RuleCard key={row.id} row={row} win={win} onSelect={onSelect} />)}
					{group.rules.length > GROUP_PREVIEW && (
						<button type="button" className={BTN_SECONDARY} onClick={() => setShowAll((v) => !v)}>
							{showAll ? "Show fewer" : `Show all ${group.rules.length.toLocaleString()} rules`}
						</button>
					)}
				</div>
			)}
		</section>
	);
}

function RuleCard({ row, win, onSelect }: {
	row: RuleReviewRow;
	win: { since: number; until: number } | null;
	onSelect: (rule: { id: string; name: string; configuredAction?: string; lastSeen?: string }) => void;
}) {
	const drift = actionDrift(row);
	return (
		<div
			role="button"
			tabIndex={0}
			title="Open rule details"
			onClick={() => onSelect({ id: row.id, name: row.name, configuredAction: row.configuredAction, lastSeen: row.lastSeen })}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect({ id: row.id, name: row.name, configuredAction: row.configuredAction, lastSeen: row.lastSeen });
				}
			}}
			className="cursor-pointer rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-cf/50 focus:outline-none focus:ring-2 focus:ring-cf/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-cf/50">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{row.name}</span>
						<RuleTypeBadge type={row.type} />
						<RuleLevelBadge level={row.level} />
						{!row.enabled && (
							<span className={BADGE_NEUTRAL}>Disabled</span>
						)}
						{row.enabled && !row.total && (
							<span className={`${BADGE} bg-sky-500/15 text-sky-700 dark:text-sky-300`}>No traffic</span>
						)}
					</div>
					{row.ruleset && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{row.ruleset}</div>}
					{row.expression && (
						<code className="mt-2 block max-h-20 overflow-auto rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs break-all dark:bg-zinc-950">
							{row.expression}
						</code>
					)}
					{drift && (
						<div className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
							Action drift: configured {titleCase(drift.configured)}, observed {titleCase(drift.observed)}
						</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-2">
					<span className="text-lg font-semibold tabular-nums">{row.total.toLocaleString()}</span>
					<span className="text-xs text-zinc-500 dark:text-zinc-400">{row.total ? relativeTime(row.lastSeen) : "no activity"}</span>
					{win && row.times.length > 0 && <Sparkline times={row.times} since={win.since} until={win.until} />}
				</div>
			</div>
			{(row.total > 0 || row.configuredAction) && (
				<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
					{row.configuredAction && (
						<span className="text-zinc-500 dark:text-zinc-400">Configured: {titleCase(row.configuredAction)}</span>
					)}
					<ActionBadges actions={row.actions} />
				</div>
			)}
			{(row.hosts.size > 0 || row.paths.size > 0) && (
				<div className="mt-2 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
					{row.hosts.size > 0 && (
						<div className="truncate">Hosts: {topEntries(row.hosts, 4).map(([h, n]) => `${h} (${n.toLocaleString()})`).join(", ")}</div>
					)}
					{row.paths.size > 0 && (
						<div className="truncate">Paths: {topEntries(row.paths, 4).map(([p, n]) => `${p} (${n.toLocaleString()})`).join(", ")}</div>
					)}
				</div>
			)}
		</div>
	);
}

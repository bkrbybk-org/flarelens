import { useMemo, useState } from "react";
import { actionDrift, aggregateRules, topEntries } from "../../lib/waf/aggregate";
import { relativeTime, titleCase } from "../../lib/waf/format";
import type { FirewallEvent, RuleMetaMap, RuleReviewRow } from "../../lib/waf/types";
import { SearchIcon } from "../../components/Icons";
import { ActionBadges, RuleLevelBadge, RuleTypeBadge, Sparkline } from "./bars";

interface RulesReviewProps {
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
	window: { since: number; until: number } | null;
}

const PAGE_SIZE = 25;

type StatusFilter = "" | "enabled" | "disabled" | "active" | "idle";

export function RulesReview({ events, ruleMeta, window: win }: RulesReviewProps) {
	const [search, setSearch] = useState("");
	const [type, setType] = useState("");
	const [level, setLevel] = useState("");
	const [status, setStatus] = useState<StatusFilter>("");
	const [page, setPage] = useState(0);

	const rows = useMemo(() => aggregateRules(events, ruleMeta), [events, ruleMeta]);

	const summary = useMemo(() => ({
		known: rows.length,
		disabled: rows.filter((r) => !r.enabled).length,
		enabledIdle: rows.filter((r) => r.enabled && !r.total).length,
		drift: rows.filter((r) => actionDrift(r)).length,
	}), [rows]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((row) => {
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
		});
	}, [rows, search, type, level, status]);

	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const clampedPage = Math.min(page, pageCount - 1);
	const pageRows = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

	const selectCls =
		"rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900";

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
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
					<input
						type="search"
						value={search}
						onChange={(e) => { setSearch(e.target.value); setPage(0); }}
						placeholder="Search rules, expressions, hosts, paths…"
						className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</div>
				<select value={type} onChange={(e) => { setType(e.target.value); setPage(0); }} aria-label="Filter by type" className={selectCls}>
					<option value="">All types</option>
					<option value="managed">Managed</option>
					<option value="custom">Custom</option>
				</select>
				<select value={level} onChange={(e) => { setLevel(e.target.value); setPage(0); }} aria-label="Filter by level" className={selectCls}>
					<option value="">All levels</option>
					<option value="account">Account</option>
					<option value="zone">Zone</option>
				</select>
				<select value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(0); }} aria-label="Filter by status" className={selectCls}>
					<option value="">All statuses</option>
					<option value="enabled">Enabled</option>
					<option value="disabled">Disabled</option>
					<option value="active">With traffic</option>
					<option value="idle">No traffic</option>
				</select>
			</div>

			<div className="space-y-3">
				{pageRows.length === 0 ? (
					<p className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
						No rules match the current filters.
					</p>
				) : (
					pageRows.map((row) => <RuleCard key={row.id} row={row} win={win} />)
				)}
			</div>

			{pageCount > 1 && (
				<nav className="flex items-center justify-end gap-1 text-sm" aria-label="Rules pagination">
					<span className="mr-2 text-zinc-500 dark:text-zinc-400">{filtered.length} rules</span>
					<button
						type="button"
						onClick={() => setPage((p) => Math.max(0, p - 1))}
						disabled={clampedPage === 0}
						className="rounded-lg border border-zinc-200 px-3 py-1.5 transition hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Prev
					</button>
					<span className="px-2 text-zinc-500 dark:text-zinc-400">{clampedPage + 1} / {pageCount}</span>
					<button
						type="button"
						onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
						disabled={clampedPage >= pageCount - 1}
						className="rounded-lg border border-zinc-200 px-3 py-1.5 transition hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Next
					</button>
				</nav>
			)}
		</div>
	);
}

function RuleCard({ row, win }: { row: RuleReviewRow; win: { since: number; until: number } | null }) {
	const drift = actionDrift(row);
	return (
		<div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{row.name}</span>
						<RuleTypeBadge type={row.type} />
						<RuleLevelBadge level={row.level} />
						{!row.enabled && (
							<span className="rounded-full bg-zinc-200 px-2 py-1 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">Disabled</span>
						)}
						{row.enabled && !row.total && (
							<span className="rounded-full bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300">No traffic</span>
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
					<span className="text-xs text-zinc-400">{row.total ? relativeTime(row.lastSeen) : "no activity"}</span>
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

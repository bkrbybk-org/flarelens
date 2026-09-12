import { Fragment, useMemo, useState } from "react";
import { EmptyRow } from "../../components/EmptyState";
import { BTN_SECONDARY } from "../../lib/ui";
import {
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnDef,
	type ColumnFiltersState,
	type SortingState,
} from "@tanstack/react-table";
import {
	ColumnFilterPopover,
	EMPTY_COLUMN_FILTER,
	facetFilterPasses,
	isColumnFilterActive,
	type ColumnFilterValue,
} from "../../components/table/ColumnFilterPopover";
import { ChevronDownIcon, ChevronUpIcon, FilterIcon } from "../../components/Icons";
import { actionDrift, actionSummary, topChildHost, topHosts, topEntries } from "../../lib/waf/aggregate";
import { relativeTime, titleCase } from "../../lib/waf/format";
import type { RulesetRow } from "../../lib/waf/types";
import { ActionBadges, ActionMixBar, RuleLevelBadge, RuleTypeBadge, ShareBar, Sparkline } from "./bars";

const PAGE_SIZE = 25;

interface RulesetTableProps {
	rows: RulesetRow[];
	globalSearch: string;
	window: { since: number; until: number } | null;
	onSelectRule: (rule: { id: string; name: string; configuredAction?: string; lastSeen?: string }) => void;
}

const COLUMN_LABELS: Record<string, string> = {
	ruleName: "Ruleset",
	type: "Type",
	level: "Level",
	actions: "Actions",
	total: "Events",
	hosts: "Top hosts",
	lastSeen: "Last seen",
};

function facetsFor(col: string, row: RulesetRow): string[] {
	switch (col) {
		case "ruleName": return [row.ruleName, ...Array.from(row.childRules.values(), (r) => r.name)];
		case "type": return [row.type];
		case "level": return [row.level];
		case "actions": return Object.keys(row.actions).map(titleCase);
		case "hosts": return [...row.hosts.keys()];
		default: return [String(row[col as keyof RulesetRow] ?? "")];
	}
}

const FILTERABLE = new Set(["ruleName", "type", "level", "actions", "hosts"]);

export function RulesetTable({ rows, globalSearch, window: win, onSelectRule }: RulesetTableProps) {
	const [sorting, setSorting] = useState<SortingState>([{ id: "total", desc: true }]);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [filterPopover, setFilterPopover] = useState<{ key: string; left: number; top: number } | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [pageIndex, setPageIndex] = useState(0);

	const columns = useMemo<ColumnDef<RulesetRow>[]>(() => [
		{
			id: "ruleName",
			accessorFn: (row) => row.ruleName,
			header: COLUMN_LABELS.ruleName,
			cell: ({ row }) => (
				<div>
					<div className="font-medium">{row.original.ruleName}</div>
					<div className="text-xs text-zinc-500 dark:text-zinc-400">
						{row.original.childRules.size} rule{row.original.childRules.size === 1 ? "" : "s"} triggered
					</div>
				</div>
			),
		},
		{ id: "type", accessorFn: (row) => row.type, header: COLUMN_LABELS.type, cell: ({ row }) => <RuleTypeBadge type={row.original.type} /> },
		{ id: "level", accessorFn: (row) => row.level, header: COLUMN_LABELS.level, cell: ({ row }) => <RuleLevelBadge level={row.original.level} /> },
		{
			id: "actions",
			accessorFn: (row) => actionSummary(row.actions),
			header: COLUMN_LABELS.actions,
			cell: ({ row }) => (
				<div className="space-y-1.5">
					<ActionMixBar actions={row.original.actions} total={row.original.total} />
					<div className="text-xs text-zinc-500 dark:text-zinc-400">{actionSummary(row.original.actions)}</div>
				</div>
			),
		},
		{
			id: "total",
			accessorFn: (row) => row.total,
			header: COLUMN_LABELS.total,
			cell: ({ row }) => (
				<div className="space-y-1">
					<span className="font-semibold tabular-nums">{row.original.total.toLocaleString()}</span>
					{win && <Sparkline times={row.original.times} since={win.since} until={win.until} />}
				</div>
			),
		},
		{
			id: "hosts",
			accessorFn: (row) => [...row.hosts.keys()].join(" "),
			header: COLUMN_LABELS.hosts,
			cell: ({ row }) => (
				<div className="space-y-0.5 text-xs">
					{topHosts(row.original).map(([host, count]) => (
						<div key={host} className="truncate" title={host}>
							{host} <span className="text-zinc-500 dark:text-zinc-400">({count.toLocaleString()})</span>
						</div>
					))}
				</div>
			),
		},
		{
			id: "lastSeen",
			accessorFn: (row) => row.lastSeen,
			header: COLUMN_LABELS.lastSeen,
			cell: ({ row }) => <span className="whitespace-nowrap text-xs">{relativeTime(row.original.lastSeen)}</span>,
		},
	], [win]);

	const table = useReactTable({
		data: rows,
		columns,
		state: { sorting, columnFilters, globalFilter: globalSearch, pagination: { pageIndex, pageSize: PAGE_SIZE } },
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		onPaginationChange: (updater) => {
			const next = typeof updater === "function" ? updater({ pageIndex, pageSize: PAGE_SIZE }) : updater;
			setPageIndex(next.pageIndex);
		},
		globalFilterFn: (row, _columnId, filterValue) => {
			const r = row.original;
			const haystack = [
				r.ruleName, r.ruleId, r.type, r.level, r.source,
				Object.keys(r.actions).join(" "),
				[...r.hosts.keys()].join(" "),
				...Array.from(r.childRules.values(), (c) => c.name),
			].join(" ").toLowerCase();
			return haystack.includes(String(filterValue).toLowerCase());
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		autoResetPageIndex: true,
	});

	const distinctValues = useMemo(() => {
		const map: Record<string, string[]> = {};
		for (const col of FILTERABLE) {
			const seen = new Set<string>();
			for (const row of rows) {
				for (const facet of facetsFor(col, row)) {
					if (facet) seen.add(facet);
				}
			}
			map[col] = [...seen].sort((a, b) => a.localeCompare(b));
		}
		return map;
	}, [rows]);

	function getColumnFilter(key: string): ColumnFilterValue {
		return (columnFilters.find((f) => f.id === key)?.value as ColumnFilterValue) || EMPTY_COLUMN_FILTER;
	}

	function setColumnFilter(key: string, value: ColumnFilterValue) {
		setColumnFilters((prev) => {
			const rest = prev.filter((f) => f.id !== key);
			return value.selected.length === 0 && !value.query ? rest : [...rest, { id: key, value }];
		});
	}

	// Column filterFns: attach facet-based filtering
	for (const col of table.getAllColumns()) {
		if (FILTERABLE.has(col.id)) {
			col.columnDef.filterFn = (row, columnId, filterValue: ColumnFilterValue) =>
				facetFilterPasses(facetsFor(columnId, row.original), filterValue);
		}
	}

	const pageRows = table.getRowModel().rows;
	const totalRows = table.getFilteredRowModel().rows.length;
	const pageCount = table.getPageCount();

	function toggleExpand(key: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	return (
		<div className="space-y-3">
			<div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
							{table.getHeaderGroups().map((hg) => (
								<tr key={hg.id}>
									<th className="w-8 px-2 py-1" aria-label="Expand" />
									{hg.headers.map((header) => {
										const sorted = header.column.getIsSorted();
										const key = header.column.id;
										return (
											<th key={header.id} className="px-2 py-1 text-left">
												<span className="flex items-center">
													<button
														type="button"
														onClick={header.column.getToggleSortingHandler()}
														className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
													>
														{flexRender(header.column.columnDef.header, header.getContext())}
														{sorted === "asc" && <ChevronUpIcon size={13} className="text-cf" />}
														{sorted === "desc" && <ChevronDownIcon size={13} className="text-cf" />}
													</button>
													{FILTERABLE.has(key) && (
														<button
															type="button"
															aria-label={`Filter ${COLUMN_LABELS[key]}`}
															onClick={(e) => {
																if (filterPopover?.key === key) {
																	setFilterPopover(null);
																	return;
																}
																const rect = e.currentTarget.getBoundingClientRect();
																setFilterPopover({ key, left: Math.min(rect.left, window.innerWidth - 288), top: rect.bottom + 4 });
															}}
															className={`rounded-md p-1 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
																isColumnFilterActive(getColumnFilter(key))
																	? "text-cf"
																	: "text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
															}`}
														>
															<FilterIcon size={13} />
														</button>
													)}
												</span>
											</th>
										);
									})}
								</tr>
							))}
						</thead>
						<tbody>
							{pageRows.length === 0 ? (
								<EmptyRow colSpan={8} title="No matching firewall activity" />
							) : (
								pageRows.map((row) => {
									const rowKey = row.original.ruleId + "::" + row.original.level + "::" + row.original.ruleName;
									const isOpen = expanded.has(rowKey);
									return (
										<Fragment key={row.id}>
											<tr
												onClick={() => toggleExpand(rowKey)}
												className="cursor-pointer border-b border-zinc-100 transition hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
											>
												<td className="px-2 py-3 text-center text-zinc-500 dark:text-zinc-400">
													{isOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
												</td>
												{row.getVisibleCells().map((cell) => (
													<td key={cell.id} className="px-4 py-3 align-top">
														{flexRender(cell.column.columnDef.cell, cell.getContext())}
													</td>
												))}
											</tr>
											{isOpen && (
												<tr className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800/60 dark:bg-zinc-950/40">
													<td colSpan={8} className="px-6 py-4">
														<div className="space-y-3">
															{[...row.original.childRules.values()].sort((a, b) => b.total - a.total).map((rule) => {
																const drift = actionDrift(rule);
																const host = topChildHost(rule);
																return (
																	<div
																		key={rule.id}
																		role="button"
																		tabIndex={0}
																		title="Open rule details"
																		onClick={(e) => {
																			e.stopPropagation();
																			onSelectRule({ id: rule.id, name: rule.name, configuredAction: rule.configuredAction, lastSeen: rule.lastSeen });
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				onSelectRule({ id: rule.id, name: rule.name, configuredAction: rule.configuredAction, lastSeen: rule.lastSeen });
																			}
																		}}
																		className="flex cursor-pointer flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 transition hover:border-cf/50 focus:outline-none focus:ring-2 focus:ring-cf/40 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:border-cf/50"
																	>
																		<div className="min-w-0 flex-1">
																			<div className="truncate text-sm font-medium" title={rule.name}>{rule.name}</div>
																			<div className="text-xs text-zinc-500 dark:text-zinc-400">
																				{rule.total.toLocaleString()} events
																				{host && <> · top host {host[0]}</>}
																				{" · "}{relativeTime(rule.lastSeen)}
																			</div>
																			{drift && (
																				<div className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
																					Action drift: configured {titleCase(drift.configured)}, observed {titleCase(drift.observed)}
																				</div>
																			)}
																		</div>
																		<ShareBar share={row.original.total ? rule.total / row.original.total : 0} />
																		{/* The badge group needs a floor width: without one its width tracks the
																		    label text ("Log 7" vs "Block 12"), which pushes the share bar left and
																		    right by up to 18px, so the bars do not line up down the column. */}
																		<div className="flex w-20 shrink-0 flex-wrap justify-end gap-1">
																			<ActionBadges actions={rule.actions} />
																		</div>
																	</div>
																);
															})}
															{row.original.hosts.size > 0 && (
																<div className="text-xs text-zinc-500 dark:text-zinc-400">
																	Hosts: {topEntries(row.original.hosts, 6).map(([h, n]) => `${h} (${n.toLocaleString()})`).join(", ")}
																</div>
															)}
														</div>
													</td>
												</tr>
											)}
										</Fragment>
									);
								})
							)}
						</tbody>
					</table>
				</div>
			</div>

			{totalRows > 0 && pageCount > 1 && (
				<nav className="flex items-center justify-end gap-1 text-sm" aria-label="Ruleset pagination">
					<span className="mr-2 text-zinc-500 dark:text-zinc-400">{totalRows} rulesets</span>
					<button
						type="button"
						onClick={() => table.previousPage()}
						disabled={!table.getCanPreviousPage()}
						className={BTN_SECONDARY}
					>
						Prev
					</button>
					<span className="px-2 text-zinc-500 dark:text-zinc-400">{pageIndex + 1} / {pageCount}</span>
					<button
						type="button"
						onClick={() => table.nextPage()}
						disabled={!table.getCanNextPage()}
						className={BTN_SECONDARY}
					>
						Next
					</button>
				</nav>
			)}

			{filterPopover && (
				<ColumnFilterPopover
					title={COLUMN_LABELS[filterPopover.key] || filterPopover.key}
					anchor={filterPopover}
					values={distinctValues[filterPopover.key] || []}
					current={getColumnFilter(filterPopover.key)}
					onChange={(next) => setColumnFilter(filterPopover.key, next)}
					onClose={() => setFilterPopover(null)}
				/>
			)}
		</div>
	);
}

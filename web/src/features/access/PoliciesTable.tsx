import { useEffect, useMemo, useState } from "react";
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
import type { CfPolicy } from "../../types";
import { downloadCsv, toCsv } from "../../lib/csv";
import { formatLocalDateTime, type RuleContext } from "../../lib/rules";
import { ChevronDownIcon, ChevronUpIcon, FilterIcon, SearchIcon } from "../../components/Icons";
import {
	ColumnFilterPopover,
	EMPTY_COLUMN_FILTER,
	facetFilterPasses,
	isColumnFilterActive,
	type ColumnFilterValue,
} from "../../components/table/ColumnFilterPopover";
import { DecisionBadge, Tag } from "./PolicyChip";
import { RuleList } from "./RuleList";
import { SkeletonRows } from "./SkeletonRows";

/**
 * Reusable policies as a table.
 *
 * Columns are declared rather than discovered from the row's own keys, the way AppsTable does it.
 * An application is a bag of loosely-related settings where showing every field is genuinely
 * useful; a policy is four things — who it lets in, what it decides, what attaches it, and when
 * it last changed — and the interesting parts (the rules) are nested arrays that make poor
 * columns. Those stay in the expandable detail row instead.
 */

interface PolicyRow {
	policy: CfPolicy;
	/** Applications attaching this policy by reference. */
	attachedTo: string[];
}

interface PoliciesTableProps {
	policies: CfPolicy[];
	usedBy: Map<string, string[]>;
	loading: boolean;
	ctx: RuleContext;
}

const COLUMNS = ["name", "decision", "rules", "attached", "updated_at", "created_at", "id"] as const;
type ColumnKey = (typeof COLUMNS)[number];

const HEADERS: Record<ColumnKey, string> = {
	name: "Name",
	decision: "Decision",
	rules: "Rules",
	attached: "Attached to",
	updated_at: "Updated",
	created_at: "Created",
	id: "ID",
};

const ruleCount = (policy: CfPolicy, field: "include" | "exclude" | "require"): number =>
	Array.isArray(policy[field]) ? (policy[field] as unknown[]).length : 0;

/** "3 include · 1 require" — enough to compare policies at a glance without unfolding each one. */
function rulesSummary(policy: CfPolicy): string {
	const parts = (["include", "exclude", "require"] as const)
		.map((field) => ({ field, count: ruleCount(policy, field) }))
		.filter(({ count }) => count > 0)
		.map(({ field, count }) => `${count} ${field}`);
	return parts.length ? parts.join(" · ") : "No rules";
}

/** Plain text per column, shared by the CSV export so exported cells match what is on screen. */
function cellText(key: ColumnKey, row: PolicyRow): string {
	const { policy, attachedTo } = row;
	switch (key) {
		case "name":
			return policy.name || policy.id;
		case "decision":
			return (policy.decision || "unknown").replaceAll("_", " ");
		case "rules":
			return rulesSummary(policy);
		case "attached":
			return attachedTo.length ? attachedTo.join(", ") : "Not attached";
		case "updated_at":
		case "created_at":
			return policy[key] != null ? formatLocalDateTime(policy[key]) : "";
		case "id":
			return policy.id;
	}
}

/**
 * Atomic values a column contributes to Excel-style filtering.
 *
 * `attached` expands to one facet per application so a reader can filter to "policies attached to
 * grafana", and an unattached policy gets its own facet rather than an empty string — that is the
 * row most worth being able to isolate.
 */
function facetValues(key: ColumnKey, row: PolicyRow): string[] {
	if (key === "attached") {
		return row.attachedTo.length ? row.attachedTo : ["Not attached"];
	}
	return [cellText(key, row)];
}

/** Sort key. Dates sort by instant, not by their rendered text, which would sort alphabetically. */
function sortValue(key: ColumnKey, row: PolicyRow): string | number {
	if (key === "updated_at" || key === "created_at") {
		const raw = row.policy[key];
		const time = raw != null ? Date.parse(String(raw)) : Number.NaN;
		// Undated rows sort last under a descending sort rather than jumping to the top.
		return Number.isNaN(time) ? 0 : time;
	}
	if (key === "attached") return row.attachedTo.length;
	return cellText(key, row).toLowerCase();
}

export function PoliciesTable({ policies, usedBy, loading, ctx }: PoliciesTableProps) {
	// Most recently changed first: on a page whose job is review, the thing that moved last is
	// the thing worth looking at.
	const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [filterPopover, setFilterPopover] = useState<{ key: string; left: number; top: number } | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [pageIndex, setPageIndex] = useState(0);
	const [perPage, setPerPage] = useState(25);

	const data = useMemo<PolicyRow[]>(
		() => policies.map((policy) => ({ policy, attachedTo: usedBy.get(policy.id) || [] })),
		[policies, usedBy],
	);

	const columns = useMemo<ColumnDef<PolicyRow>[]>(
		() =>
			COLUMNS.map((key) => ({
				id: key,
				accessorFn: (row) => sortValue(key, row),
				header: HEADERS[key],
				filterFn: (row, _columnId, filterValue: ColumnFilterValue) => facetFilterPasses(facetValues(key, row.original), filterValue),
			})),
		[],
	);

	const table = useReactTable({
		data,
		columns,
		state: { sorting, globalFilter, columnFilters, pagination: { pageIndex, pageSize: perPage } },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
		onColumnFiltersChange: setColumnFilters,
		globalFilterFn: (row, _columnId, filterValue) =>
			JSON.stringify(row.original.policy).toLowerCase().includes(String(filterValue).toLowerCase()) ||
			row.original.attachedTo.join(" ").toLowerCase().includes(String(filterValue).toLowerCase()),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		autoResetPageIndex: false,
	});

	useEffect(() => {
		setPageIndex(0);
	}, [globalFilter, columnFilters, policies]);

	const distinctValues = useMemo(() => {
		const map: Record<string, string[]> = {};
		for (const key of COLUMNS) {
			const seen = new Set<string>();
			for (const row of data) {
				for (const facet of facetValues(key, row)) seen.add(facet);
			}
			map[key] = [...seen].sort((a, b) => a.localeCompare(b));
		}
		return map;
	}, [data]);

	const getColumnFilter = (key: string): ColumnFilterValue =>
		(columnFilters.find((f) => f.id === key)?.value as ColumnFilterValue) || EMPTY_COLUMN_FILTER;

	function setColumnFilter(key: string, value: ColumnFilterValue) {
		setColumnFilters((prev) => {
			const rest = prev.filter((f) => f.id !== key);
			if (value.selected.length === 0 && !value.query) return rest;
			return [...rest, { id: key, value }];
		});
	}

	const rows = table.getRowModel().rows;
	const totalRows = table.getFilteredRowModel().rows.length;
	const pageCount = table.getPageCount();

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-56">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
					<input
						type="search"
						value={globalFilter}
						onChange={(e) => setGlobalFilter(e.target.value)}
						placeholder="Search policies, decisions, rules…"
						disabled={loading}
						className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</div>
				<button
					type="button"
					onClick={() => {
						const csv = toCsv(
							table.getFilteredRowModel().rows,
							COLUMNS.map((key) => ({ header: HEADERS[key], value: (row) => cellText(key, row.original) })),
						);
						downloadCsv(`flarelens-reusable-policies-${new Date().toISOString().slice(0, 10)}.csv`, csv);
					}}
					disabled={loading || totalRows === 0}
					className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
				>
					Export CSV
				</button>
			</div>

			<div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
				<div className="overflow-auto">
					<table className="w-full text-sm">
						<thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
							{table.getHeaderGroups().map((hg) => (
								<tr key={hg.id}>
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
													<button
														type="button"
														aria-label={`Filter ${HEADERS[key as ColumnKey]}`}
														onClick={(e) => {
															e.stopPropagation();
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
												</span>
											</th>
										);
									})}
								</tr>
							))}
						</thead>
						<tbody>
							{loading ? (
								<SkeletonRows cols={COLUMNS.length} />
							) : rows.length === 0 ? (
								<tr>
									<td colSpan={COLUMNS.length} className="px-4 py-16 text-center text-zinc-500 dark:text-zinc-400">
										No matching policies.
									</td>
								</tr>
							) : (
								rows.map((row) => {
									const { policy, attachedTo } = row.original;
									const isOpen = expanded === policy.id;
									return (
										<>
											<tr
												key={row.id}
												onClick={() => setExpanded(isOpen ? null : policy.id)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														setExpanded(isOpen ? null : policy.id);
													}
												}}
												tabIndex={0}
												aria-expanded={isOpen}
												className="cursor-pointer border-b border-zinc-100 transition last:border-0 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none dark:border-zinc-800/60 dark:hover:bg-zinc-800/40 dark:focus:bg-zinc-800/40"
											>
												<td className="px-4 py-3 font-medium">{policy.name || policy.id}</td>
												<td className="px-4 py-3">{policy.decision && <DecisionBadge decision={policy.decision} />}</td>
												<td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">{rulesSummary(policy)}</td>
												<td className="px-4 py-3">
													{attachedTo.length ? (
														<span className="flex flex-wrap gap-1">
															{attachedTo.map((name) => <Tag key={name} label={name} />)}
														</span>
													) : (
														// The row most worth spotting: configuration that enforces nothing.
														<span className="text-amber-600 dark:text-amber-400">Not attached</span>
													)}
												</td>
												<td className="whitespace-nowrap px-4 py-3 tabular-nums text-zinc-500 dark:text-zinc-400">
													{policy.updated_at != null ? formatLocalDateTime(policy.updated_at) : "—"}
												</td>
												<td className="whitespace-nowrap px-4 py-3 tabular-nums text-zinc-500 dark:text-zinc-400">
													{policy.created_at != null ? formatLocalDateTime(policy.created_at) : "—"}
												</td>
												<td className="px-4 py-3 font-mono text-xs text-zinc-400">{policy.id}</td>
											</tr>
											{isOpen && (
												<tr key={`${row.id}-detail`} className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800/60 dark:bg-zinc-800/20">
													<td colSpan={COLUMNS.length} className="px-4 py-4">
														<RuleList policy={policy} ctx={ctx} />
														<details className="mt-3">
															<summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
																Raw JSON
															</summary>
															<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950">
																{JSON.stringify(policy, null, 2)}
															</pre>
														</details>
													</td>
												</tr>
											)}
										</>
									);
								})
							)}
						</tbody>
					</table>
				</div>
			</div>

			{!loading && totalRows > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
						<select
							value={perPage}
							onChange={(e) => setPerPage(Number(e.target.value))}
							aria-label="Rows per page"
							className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						>
							{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} rows</option>)}
						</select>
						<span>{totalRows} total</span>
					</div>
					{pageCount > 1 && (
						<nav className="flex items-center gap-1" aria-label="Pagination">
							<button
								type="button"
								onClick={() => table.previousPage()}
								disabled={!table.getCanPreviousPage()}
								className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm transition hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
							>
								Prev
							</button>
							<span className="px-2 text-sm text-zinc-500 dark:text-zinc-400">
								{pageIndex + 1} / {pageCount}
							</span>
							<button
								type="button"
								onClick={() => table.nextPage()}
								disabled={!table.getCanNextPage()}
								className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm transition hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
							>
								Next
							</button>
						</nav>
					)}
				</div>
			)}

			{filterPopover && (
				<ColumnFilterPopover
					title={HEADERS[filterPopover.key as ColumnKey]}
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

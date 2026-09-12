import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyRow, EmptyState } from "../../components/EmptyState";
import { BTN_SECONDARY, FOCUS_RING, FOCUS_ROW, SEARCH_INPUT } from "../../lib/ui";
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
	type VisibilityState,
} from "@tanstack/react-table";
import type { CfApp, CfPolicy } from "../../types";
import { downloadCsv, toCsv } from "../../lib/csv";
import { formatColumnLabel, formatLocalDateTime, resolvePolicy, type RuleContext } from "../../lib/rules";
import { ChevronDownIcon, ChevronUpIcon, ColumnsIcon, FilterIcon, SearchIcon } from "../../components/Icons";
import {
	ColumnFilterPopover,
	EMPTY_COLUMN_FILTER,
	facetFilterPasses,
	isColumnFilterActive,
	type ColumnFilterValue,
} from "../../components/table/ColumnFilterPopover";
import { DecisionBadge, ErrorBadge, PolicyChip, Tag } from "./PolicyChip";
import { SkeletonCards, SkeletonRows } from "./SkeletonRows";

// Order matters: drives default column order when the user has not saved one
const DEFAULT_VISIBLE = ["name", "destinations", "tags", "allowed_idps", "policies", "logins_7d", "updated_at", "type", "session_duration"];
const HIDDEN_KEYS = new Set(["policies_error"]);

interface AppsTableProps {
	apps: CfApp[];
	loading: boolean;
	ctx: RuleContext;
	reusableMap: Record<string, CfPolicy>;
	onSelect: (app: CfApp) => void;
	perPage: number;
	density: "comfortable" | "compact";
	columnVisibility: VisibilityState;
	columnOrder: string[];
	onPrefsChange: (patch: {
		perPage?: number;
		density?: "comfortable" | "compact";
		columnVisibility?: VisibilityState;
		columnOrder?: string[];
	}) => void;
}

function sortableValue(val: unknown): string | number | boolean {
	if (val === null || val === undefined) return "";
	if (typeof val === "object") return JSON.stringify(val);
	return val as string | number | boolean;
}

// Atomic values a column contributes for Excel-style filtering: array cells
// expand to their elements so e.g. individual tags are selectable.
function facetValues(col: string, app: CfApp, ctx: RuleContext, reusableMap: Record<string, CfPolicy>): string[] {
	const value = app[col];
	if (col === "policies") {
		if (app.policies_error) return ["Policies unavailable"];
		if (app.policies.length === 0) return ["(none)"];
		const facets: string[] = [];
		for (const raw of app.policies) {
			const p = resolvePolicy(raw, reusableMap);
			if (p.name) facets.push(p.name);
			if (p.decision) facets.push(p.decision.toLowerCase());
		}
		return facets;
	}
	if (value === null || value === undefined) return ["(empty)"];
	if (col === "allowed_idps" && Array.isArray(value)) {
		return value.length ? (value as string[]).map((id) => ctx.idpName(id)) : ["(none)"];
	}
	if (col === "destinations" && Array.isArray(value)) {
		return value.length
			? (value as Record<string, string>[]).map((d) => d.uri || d.cidr || d.hostname || d.ip || JSON.stringify(d))
			: ["(none)"];
	}
	if (Array.isArray(value)) {
		return value.length ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))) : ["(none)"];
	}
	if (col === "updated_at" || col === "created_at") return [formatLocalDateTime(value)];
	if (typeof value === "boolean") return [value ? "True" : "False"];
	if (typeof value === "object") return [JSON.stringify(value)];
	return [String(value)];
}

function DefaultCell({ value }: { value: unknown }) {
	if (value === null || value === undefined) {
		return <span className="text-zinc-500 dark:text-zinc-400">—</span>;
	}
	if (typeof value === "boolean") {
		return <Tag label={value ? "True" : "False"} />;
	}
	if (typeof value === "object") {
		return <span className="break-all text-xs">{JSON.stringify(value)}</span>;
	}
	return <>{String(value)}</>;
}

// Plain-text mirror of renderCell: CSV export needs the same human-readable
// value the table shows, but renderCell returns JSX so it can't be reused
// directly. Keep these two in lockstep — any new column case in renderCell
// needs the matching case here, or the export will regress back to raw JSON.
export function formatCellText(col: string, app: CfApp, ctx: RuleContext, reusableMap: Record<string, CfPolicy>): string {
	const value = app[col];
	if (col === "policies") {
		if (app.policies_error) return "Policies unavailable";
		return app.policies
			.map((raw) => {
				const p = resolvePolicy(raw, reusableMap);
				const decision = (p.decision || "unknown").replaceAll("_", " ");
				return `${p.name || "Unnamed Policy"} (${decision})`;
			})
			.join(", ");
	}
	if ((col === "tags" || col === "self_hosted_domains") && Array.isArray(value)) {
		return (value as string[]).join(", ");
	}
	if (col === "allowed_idps" && Array.isArray(value)) {
		return (value as string[]).map((id) => ctx.idpName(id)).join(", ");
	}
	if (col === "destinations" && Array.isArray(value)) {
		return (value as Record<string, string>[])
			.map((d) => d.uri || d.cidr || d.hostname || d.ip || JSON.stringify(d))
			.join(", ");
	}
	if ((col === "updated_at" || col === "created_at") && value != null) {
		return formatLocalDateTime(value);
	}
	// Null means the telemetry could not be read; zero means it was read and nobody signed in.
	// Exporting both as an empty cell would erase that distinction.
	if (col === "logins_7d") return value === null || value === undefined ? "unavailable" : String(value);
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function renderCell(col: string, app: CfApp, ctx: RuleContext, reusableMap: Record<string, CfPolicy>) {
	const value = app[col];
	if (col === "policies") {
		if (app.policies_error) {
			return <ErrorBadge label="Policies unavailable" />;
		}
		return (
			<span className="flex flex-col items-start gap-1.5">
				{app.policies.map((raw) => {
					const p = resolvePolicy(raw, reusableMap);
					return <PolicyChip key={p.id} name={p.name || "Unnamed Policy"} decision={p.decision || "unknown"} />;
				})}
			</span>
		);
	}
	if ((col === "tags" || col === "self_hosted_domains") && Array.isArray(value)) {
		return <span className="flex flex-wrap gap-1">{(value as string[]).map((v) => <Tag key={v} label={v} />)}</span>;
	}
	if (col === "allowed_idps" && Array.isArray(value)) {
		return <span className="flex flex-wrap gap-1">{(value as string[]).map((id) => <Tag key={id} label={ctx.idpName(id)} />)}</span>;
	}
	if (col === "destinations" && Array.isArray(value)) {
		return (
			<span className="flex flex-wrap gap-1">
				{(value as Record<string, string>[]).map((d, i) => (
					<Tag key={i} label={d.uri || d.cidr || d.hostname || d.ip || JSON.stringify(d)} />
				))}
			</span>
		);
	}
	if ((col === "updated_at" || col === "created_at") && value != null) {
		return <span className="whitespace-nowrap tabular-nums">{formatLocalDateTime(value)}</span>;
	}
	if (col === "name") {
		return <span className="font-medium">{String(value ?? "-")}</span>;
	}
	if (col === "logins_7d") {
		if (value === null || value === undefined) {
			return (
				<span className="text-zinc-500 dark:text-zinc-400" title="Login telemetry could not be read for this account.">
					—
				</span>
			);
		}
		const count = Number(value);
		return (
			<span
				className={`tabular-nums ${count === 0 ? "text-amber-600 dark:text-amber-400" : ""}`}
				title={
					count === 0
						? "No logins in the last 7 days. Cloudflare caps this dataset at one week, so this means 'not this week', not 'never'."
						: undefined
				}
			>
				{count.toLocaleString()}
			</span>
		);
	}
	return <DefaultCell value={value} />;
}

export function AppsTable({
	apps, loading, ctx, reusableMap, onSelect,
	perPage, density, columnVisibility, columnOrder, onPrefsChange,
}: AppsTableProps) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [columnsOpen, setColumnsOpen] = useState(false);
	const [filterPopover, setFilterPopover] = useState<{ key: string; left: number; top: number } | null>(null);
	const [dragOverKey, setDragOverKey] = useState<string | null>(null);
	const draggedKeyRef = useRef<string | null>(null);
	const columnsMenuRef = useRef<HTMLDivElement>(null);

	const allKeys = useMemo(() => {
		const keys: string[] = [];
		const seen = new Set<string>();
		for (const app of apps) {
			for (const key of Object.keys(app)) {
				if (!seen.has(key) && !HIDDEN_KEYS.has(key)) {
					seen.add(key);
					keys.push(key);
				}
			}
		}
		return keys;
	}, [apps]);

	const columns = useMemo<ColumnDef<CfApp>[]>(
		() =>
			allKeys.map((key) => ({
				id: key,
				accessorFn: (row) => sortableValue(row[key]),
				header: formatColumnLabel(key),
				cell: ({ row }) => renderCell(key, row.original, ctx, reusableMap),
				filterFn: (row, columnId, filterValue: ColumnFilterValue) =>
					facetFilterPasses(facetValues(columnId, row.original, ctx, reusableMap), filterValue),
			})),
		[allKeys, ctx, reusableMap],
	);

	// Effective visibility: stored prefs win; otherwise defaults.
	const effectiveVisibility = useMemo<VisibilityState>(() => {
		const vis: VisibilityState = {};
		for (const key of allKeys) {
			vis[key] = columnVisibility[key] ?? DEFAULT_VISIBLE.includes(key);
		}
		return vis;
	}, [allKeys, columnVisibility]);

	const effectiveOrder = useMemo(() => {
		// Default columns first in their defined order, then everything else
		const baseOrder = [
			...DEFAULT_VISIBLE.filter((key) => allKeys.includes(key)),
			...allKeys.filter((key) => !DEFAULT_VISIBLE.includes(key)),
		];
		const known = columnOrder.filter((key) => allKeys.includes(key));
		const rest = baseOrder.filter((key) => !known.includes(key));
		return [...known, ...rest];
	}, [allKeys, columnOrder]);

	const [pageIndex, setPageIndex] = useState(0);

	const table = useReactTable({
		data: apps,
		columns,
		state: {
			sorting,
			globalFilter,
			columnFilters,
			columnVisibility: effectiveVisibility,
			columnOrder: effectiveOrder,
			pagination: { pageIndex, pageSize: perPage },
		},
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
		onColumnFiltersChange: setColumnFilters,
		onPaginationChange: (updater) => {
			const next = typeof updater === "function" ? updater({ pageIndex, pageSize: perPage }) : updater;
			setPageIndex(next.pageIndex);
			if (next.pageSize !== perPage) {
				onPrefsChange({ perPage: next.pageSize });
			}
		},
		globalFilterFn: (row, _columnId, filterValue) =>
			JSON.stringify(row.original).toLowerCase().includes(String(filterValue).toLowerCase()),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		autoResetPageIndex: false,
	});

	useEffect(() => {
		setPageIndex(0);
	}, [globalFilter, columnFilters, apps]);

	// Distinct facet values per column for the filter popover
	const distinctValues = useMemo(() => {
		const map: Record<string, string[]> = {};
		for (const key of allKeys) {
			const seen = new Set<string>();
			for (const app of apps) {
				for (const facet of facetValues(key, app, ctx, reusableMap)) {
					seen.add(facet);
				}
			}
			map[key] = [...seen].sort((a, b) => a.localeCompare(b));
		}
		return map;
	}, [allKeys, apps, ctx, reusableMap]);

	function getColumnFilter(key: string): ColumnFilterValue {
		return (columnFilters.find((f) => f.id === key)?.value as ColumnFilterValue) || EMPTY_COLUMN_FILTER;
	}

	function setColumnFilter(key: string, value: ColumnFilterValue) {
		setColumnFilters((prev) => {
			const rest = prev.filter((f) => f.id !== key);
			if (value.selected.length === 0 && !value.query) {
				return rest;
			}
			return [...rest, { id: key, value }];
		});
	}

	// Close the columns menu on outside click
	useEffect(() => {
		if (!columnsOpen) return;
		const onDown = (e: MouseEvent) => {
			if (!columnsMenuRef.current?.contains(e.target as Node)) {
				setColumnsOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [columnsOpen]);

	const rows = table.getRowModel().rows;
	const pageCount = table.getPageCount();
	const totalRows = table.getFilteredRowModel().rows.length;
	const cellPad = density === "compact" ? "px-4 py-2" : "px-4 py-3.5";
	const visibleCount = table.getVisibleLeafColumns().length;

	function moveColumn(key: string, dir: -1 | 1) {
		const order = [...effectiveOrder];
		const from = order.indexOf(key);
		const to = from + dir;
		if (to < 0 || to >= order.length) return;
		order.splice(from, 1);
		order.splice(to, 0, key);
		onPrefsChange({ columnOrder: order });
	}

	function reorderColumn(fromKey: string, toKey: string) {
		if (fromKey === toKey) return;
		const order = [...effectiveOrder];
		const from = order.indexOf(fromKey);
		const to = order.indexOf(toKey);
		if (from === -1 || to === -1) return;
		order.splice(from, 1);
		order.splice(to, 0, fromKey);
		onPrefsChange({ columnOrder: order });
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-56">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
					<input
						type="search"
						value={globalFilter}
						onChange={(e) => setGlobalFilter(e.target.value)}
						placeholder="Search applications…"
						disabled={loading}
						className={SEARCH_INPUT}
					/>
				</div>

				<div ref={columnsMenuRef} className="relative">
					<button
						type="button"
						onClick={() => setColumnsOpen((v) => !v)}
						disabled={loading}
						aria-expanded={columnsOpen}
						className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
					>
						<ColumnsIcon size={15} />
						Columns
					</button>
					{columnsOpen && (
						<div className="absolute right-0 z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
							{effectiveOrder.map((key, i) => (
								<div key={key} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800">
									<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={effectiveVisibility[key]}
											onChange={(e) =>
												onPrefsChange({ columnVisibility: { ...effectiveVisibility, [key]: e.target.checked } })
											}
											className="accent-cf"
										/>
										<span className="truncate">{formatColumnLabel(key)}</span>
									</label>
									<button
										type="button"
										aria-label={`Move ${formatColumnLabel(key)} up`}
										disabled={i === 0}
										onClick={() => moveColumn(key, -1)}
										className="rounded p-0.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200"
									>
										<ChevronUpIcon size={14} />
									</button>
									<button
										type="button"
										aria-label={`Move ${formatColumnLabel(key)} down`}
										disabled={i === effectiveOrder.length - 1}
										onClick={() => moveColumn(key, 1)}
										className="rounded p-0.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200"
									>
										<ChevronDownIcon size={14} />
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				<button
					type="button"
					onClick={() => onPrefsChange({ density: density === "compact" ? "comfortable" : "compact" })}
					disabled={loading}
					title="Toggle row density"
					className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
				>
					{density === "compact" ? "Comfortable" : "Compact"}
				</button>

				<button
					type="button"
					onClick={() => {
						const visibleColumns = table.getVisibleLeafColumns();
						const csv = toCsv(table.getFilteredRowModel().rows, visibleColumns.map((col) => ({
							header: formatColumnLabel(col.id),
							// Use the same text the table renders (not the raw row value)
							// so exported cells match what's on screen.
							value: (row) => formatCellText(col.id, row.original, ctx, reusableMap),
						})));
						downloadCsv(`flarelens-access-apps-${new Date().toISOString().slice(0, 10)}.csv`, csv);
					}}
					disabled={loading}
					className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
				>
					Export CSV
				</button>
			</div>

			{/* Desktop table — the only vertical scroll region on the page */}
			<div className="hidden min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white md:block dark:border-zinc-800 dark:bg-zinc-900">
				<div className="h-full overflow-auto">
					<table className="w-full text-sm">
						<thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
							{table.getHeaderGroups().map((hg) => (
								<tr key={hg.id}>
									{hg.headers.map((header) => {
										const sorted = header.column.getIsSorted();
										const key = header.column.id;
										return (
											<th
												key={header.id}
												draggable
												onDragStart={(e) => {
													draggedKeyRef.current = key;
													e.dataTransfer.effectAllowed = "move";
												}}
												onDragOver={(e) => {
													e.preventDefault();
													e.dataTransfer.dropEffect = "move";
												}}
												onDragEnter={() => {
													if (draggedKeyRef.current && draggedKeyRef.current !== key) {
														setDragOverKey(key);
													}
												}}
												onDragLeave={(e) => {
													if (!e.currentTarget.contains(e.relatedTarget as Node)) {
														setDragOverKey((k) => (k === key ? null : k));
													}
												}}
												onDrop={(e) => {
													e.preventDefault();
													if (draggedKeyRef.current) {
														reorderColumn(draggedKeyRef.current, key);
													}
													draggedKeyRef.current = null;
													setDragOverKey(null);
												}}
												onDragEnd={() => {
													draggedKeyRef.current = null;
													setDragOverKey(null);
												}}
												className={`cursor-grab px-2 py-1 text-left active:cursor-grabbing ${
													dragOverKey === key ? "bg-cf/10 outline-2 outline-dashed outline-cf/60 -outline-offset-2" : ""
												}`}
											>
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
														aria-label={`Filter ${formatColumnLabel(key)}`}
														onClick={(e) => {
															e.stopPropagation();
															if (filterPopover?.key === key) {
																setFilterPopover(null);
																return;
															}
															const rect = e.currentTarget.getBoundingClientRect();
															setFilterPopover({
																key,
																left: Math.min(rect.left, window.innerWidth - 288),
																top: rect.bottom + 4,
															});
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
								<SkeletonRows cols={Math.max(visibleCount, 1)} />
							) : rows.length === 0 ? (
								<EmptyRow colSpan={Math.max(visibleCount, 1)} title="No matching applications" />
							) : (
								rows.map((row) => (
									<tr
										key={row.id}
										onClick={() => onSelect(row.original)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												onSelect(row.original);
											}
										}}
										tabIndex={0}
										className={`cursor-pointer border-b border-zinc-100 transition last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40 ${FOCUS_ROW}`}
									>
										{row.getVisibleCells().map((cell) => (
											<td key={cell.id} className={`${cellPad} align-top`}>
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</td>
										))}
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>

			{/* Mobile cards — scrolls independently, page stays fixed */}
			<div className="min-h-0 flex-1 overflow-y-auto md:hidden">
				{loading ? (
					<SkeletonCards />
				) : rows.length === 0 ? (
					<EmptyState title="No matching applications" hint="Try a different search or filter." />
				) : (
					<div className="space-y-3">
						{rows.map((row) => {
							const app = row.original;
							return (
								<button
									key={row.id}
									type="button"
									onClick={() => onSelect(app)}
									className="block w-full rounded-xl border border-zinc-200 bg-white p-4 text-left transition hover:border-cf/50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-cf/50"
								>
									<div className="mb-1 flex items-center justify-between gap-2">
										<span className="truncate font-medium">{app.name || "Unnamed"}</span>
										{app.policies_error ? (
											<ErrorBadge label="error" />
										) : (
											app.policies[0]?.decision && <DecisionBadge decision={app.policies[0].decision} />
										)}
									</div>
									<div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{app.domain || app.id}</div>
									<div className="mt-2 flex flex-wrap gap-1">
										{(app.tags || []).map((t) => <Tag key={t} label={t} />)}
									</div>
									{app.updated_at != null && (
										<div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Updated {formatLocalDateTime(app.updated_at)}</div>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Pagination */}
			{!loading && totalRows > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
						<select
							value={perPage}
							onChange={(e) => table.setPageSize(Number(e.target.value))}
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
								className={BTN_SECONDARY}
							>
								Prev
							</button>
							{Array.from({ length: pageCount }, (_, i) => i)
								.filter((i) => i === 0 || i === pageCount - 1 || Math.abs(i - pageIndex) <= 1)
								.reduce<(number | "gap")[]>((acc, i, idx, arr) => {
									if (idx > 0 && i - (arr[idx - 1]) > 1) acc.push("gap");
									acc.push(i);
									return acc;
								}, [])
								.map((item, idx) =>
									item === "gap" ? (
										<span key={`gap-${idx}`} className="px-1 text-zinc-500 dark:text-zinc-400">…</span>
									) : (
										<button
											key={item}
											type="button"
											onClick={() => table.setPageIndex(item)}
											aria-current={item === pageIndex ? "page" : undefined}
											className={
												item === pageIndex
													? `rounded-lg bg-cf px-3 py-1.5 text-sm font-medium text-white ${FOCUS_RING}`
													: BTN_SECONDARY
											}
										>
											{item + 1}
										</button>
									),
								)}
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
				</div>
			)}

			{/* Excel-style column filter popover */}
			{filterPopover && (
				<ColumnFilterPopover
					title={formatColumnLabel(filterPopover.key)}
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

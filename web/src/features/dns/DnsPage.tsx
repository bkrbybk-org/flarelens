import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnDef,
	type SortingState,
} from "@tanstack/react-table";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { useHashSyncedState } from "../../hooks/useHashParams";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, BADGE, BADGE_NEUTRAL, BTN_SECONDARY, CARD, MUTED, SEARCH_INPUT, SECTION_TITLE, SELECT } from "../../lib/ui";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import { cacheAgeLabel } from "../../lib/edge-cache-caption";
import type { Session } from "../../hooks/useSession";
import { useDnsRecordsReport } from "./useDnsRecordsReport";
import { formatTtl } from "./ttl";
import type { DnsRow } from "./types";

function ProxyBadge({ proxied }: { proxied: boolean }) {
	return (
		<span className={`${BADGE} ${proxied ? "bg-cf/10 text-cf" : BADGE_NEUTRAL}`}>
			{proxied ? "Proxied" : "DNS only"}
		</span>
	);
}

function FlagBadges({ flags }: { flags: DnsRow["flags"] }) {
	if (flags.length === 0) return <span className={MUTED}>—</span>;
	return (
		<span className="flex flex-wrap gap-1">
			{flags.map((flag) => (
				<span
					key={flag}
					className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`}
					title="DNS-only, but this record could be proxied — the origin's real address is published."
				>
					origin exposed
				</span>
			))}
		</span>
	);
}

const COLUMNS: ColumnDef<DnsRow>[] = [
	{ id: "zoneName", header: "Zone", accessorFn: (r) => r.zoneName },
	{ id: "type", header: "Type", accessorFn: (r) => r.type },
	{ id: "name", header: "Name", accessorFn: (r) => r.name, cell: ({ row }) => <span className="font-mono text-xs">{row.original.name}</span> },
	{
		id: "content",
		header: "Content",
		accessorFn: (r) => r.content,
		cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.content || <span className={MUTED}>—</span>}</span>,
	},
	{
		id: "proxied",
		header: "Proxy status",
		accessorFn: (r) => (r.proxied ? 1 : 0),
		cell: ({ row }) => <ProxyBadge proxied={row.original.proxied} />,
	},
	{
		id: "ttl",
		header: "TTL",
		accessorFn: (r) => r.ttl,
		cell: ({ row }) => <span className="tabular-nums">{formatTtl(row.original.ttl)}</span>,
	},
	{
		id: "flags",
		header: "Flags",
		accessorFn: (r) => r.flags.join(","),
		cell: ({ row }) => <FlagBadges flags={row.original.flags} />,
	},
	{
		id: "modified_on",
		header: "Modified",
		accessorFn: (r) => r.modified_on || "",
		cell: ({ row }) => <span className={`whitespace-nowrap text-xs ${MUTED}`}>{row.original.modified_on ? new Date(row.original.modified_on).toLocaleString() : "—"}</span>,
	},
];

export function DnsPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [typeFilter, setTypeFilter] = useState("");
	const [zoneFilter, setZoneFilter] = useState("");
	const [sorting, setSorting] = useState<SortingState>([{ id: "zoneName", desc: false }]);
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, cachedAt, progress, load } = useDnsRecordsReport(onAuthError);
	// Only Sync bypasses the edge cache; a mount or account switch takes the fast cached read.
	const freshOnNextLoadRef = useRef(false);
	useSectionRefresh(
		useCallback(() => {
			freshOnNextLoadRef.current = true;
			setReloadKey((k) => k + 1);
		}, []),
		loading,
	);

	useEffect(() => {
		const fresh = freshOnNextLoadRef.current;
		freshOnNextLoadRef.current = false;
		load(session.token, session.accountId, fresh);
	}, [session.token, session.accountId, reloadKey, load]);

	useHashSyncedState("type", typeFilter, setTypeFilter, "dns");
	useHashSyncedState("zone", zoneFilter, setZoneFilter, "dns");

	const rows = useMemo(() => result?.rows ?? [], [result]);

	const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
	const zones = useMemo(() => {
		const seen = new Map<string, string>();
		for (const r of rows) seen.set(r.zoneId, r.zoneName);
		return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	}, [rows]);

	const filteredRows = useMemo(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (typeFilter && r.type !== typeFilter) return false;
			if (zoneFilter && r.zoneId !== zoneFilter) return false;
			if (!q) return true;
			return `${r.name} ${r.content} ${r.zoneName} ${r.comment ?? ""} ${r.tags.join(" ")}`.toLowerCase().includes(q);
		});
	}, [rows, search, typeFilter, zoneFilter]);

	const table = useReactTable({
		data: filteredRows,
		columns: COLUMNS,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});
	const tableRows = table.getRowModel().rows;

	const summary = result?.summary ?? { totalRecords: 0, proxiedCount: 0, dnsOnlyCount: 0, exposedOriginCount: 0, byType: {}, byZone: [] };

	function exportCsv() {
		const csv = toCsv(filteredRows, [
			{ header: "zone", value: (r) => r.zoneName },
			{ header: "type", value: (r) => r.type },
			{ header: "name", value: (r) => r.name },
			{ header: "content", value: (r) => r.content },
			{ header: "proxied", value: (r) => (r.proxied ? "true" : "false") },
			{ header: "ttl", value: (r) => formatTtl(r.ttl) },
			{ header: "comment", value: (r) => r.comment ?? "" },
			{ header: "tags", value: (r) => r.tags.join(", ") },
			{ header: "flags", value: (r) => r.flags.join(", ") },
			{ header: "modified_on", value: (r) => r.modified_on ?? "" },
		]);
		downloadCsv(`dns-records-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<PageShell progress={progress}>
			{cachedAt && <p className={`text-xs ${MUTED}`}>{cacheAgeLabel(cachedAt)}</p>}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{result?.zoneErrors.map((e) => (
				<div key={e.zoneId} role="status" className={ALERT_WARN}>
					{e.zoneName}: {e.reason}
				</div>
			))}

			<StatGrid cols={4}>
				<StatCard label="Total records" value={summary.totalRecords} hint={`across ${summary.byZone.length} zone${summary.byZone.length === 1 ? "" : "s"}`} />
				<StatCard label="Proxied" value={summary.proxiedCount} hint="behind Cloudflare" />
				<StatCard label="DNS only" value={summary.dnsOnlyCount} hint="resolves straight to content" />
				<StatCard
					label="Exposed origins"
					value={summary.exposedOriginCount}
					tone={summary.exposedOriginCount ? "text-amber-700 dark:text-amber-400" : undefined}
					hint="DNS-only, but proxiable"
				/>
			</StatGrid>

			<section className={CARD}>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className={SECTION_TITLE}>DNS records</h2>
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-0 flex-1 basis-64">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
							<input
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search name, content, zone…"
								aria-label="Search DNS records"
								className={SEARCH_INPUT}
							/>
						</div>
						<select
							value={typeFilter}
							onChange={(e) => setTypeFilter(e.target.value)}
							aria-label="Filter by record type"
							className={SELECT}
						>
							<option value="">All types</option>
							{types.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
						<select
							value={zoneFilter}
							onChange={(e) => setZoneFilter(e.target.value)}
							aria-label="Filter by zone"
							className={SELECT}
						>
							<option value="">All zones</option>
							{zones.map(([id, name]) => (
								<option key={id} value={id}>
									{name}
								</option>
							))}
						</select>
						<button type="button" onClick={exportCsv} disabled={!filteredRows.length} className={BTN_SECONDARY}>
							Export CSV
						</button>
					</div>
				</div>

				{rows.length === 0 ? (
					<EmptyNote title="No DNS records found" loading={loading} />
				) : filteredRows.length === 0 ? (
					<EmptyNote title="No matching records" loading={loading} />
				) : (
					<div className="mt-3 overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
								<tr>
									{table.getHeaderGroups()[0].headers.map((header) => {
										const sorted = header.column.getIsSorted();
										return (
											<th key={header.id} className="py-1.5 pr-3 font-medium">
												<button
													type="button"
													onClick={header.column.getToggleSortingHandler()}
													className="flex items-center gap-1 uppercase tracking-wide hover:text-zinc-800 dark:hover:text-zinc-100"
												>
													{flexRender(header.column.columnDef.header, header.getContext())}
													{sorted === "asc" && <ChevronUpIcon size={13} className="text-cf" />}
													{sorted === "desc" && <ChevronDownIcon size={13} className="text-cf" />}
												</button>
											</th>
										);
									})}
								</tr>
							</thead>
							<tbody>
								{tableRows.map((row) => (
									<tr key={row.original.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
										{row.getVisibleCells().map((cell) => (
											<td key={cell.id} className="py-1.5 pr-3">
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</PageShell>
	);
}

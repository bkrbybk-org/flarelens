import { Fragment, useMemo, useState } from "react";
import { EmptyNote } from "../../components/EmptyState";
import { ALERT_WARN, BTN_SECONDARY, CARD, FOCUS_RING, SECTION_TITLE } from "../../lib/ui";
import {
	columnFilteringFeature,
	columnVisibilityFeature,
	createFilteredRowModel,
	createSortedRowModel,
	flexRender,
	globalFilteringFeature,
	rowSortingFeature,
	tableFeatures,
	useTable,
	type ColumnDef,
	type SortingState,
} from "@tanstack/react-table";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { RawEvent, Severity } from "../../lib/ai-sec/types";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "../../components/Icons";
import { DecryptKeyPanel, PromptPayload } from "./PromptPayload";

/**
 * Flagged requests.
 *
 * The original was a hand-built CSS grid with its own sort, search and per-column value
 * pickers, because it had to work without JavaScript. Flarelens is a SPA with
 * @tanstack/react-table already in use for the Access table, so this is that table's job now —
 * the sorting and filtering behaviour comes from the library rather than being reimplemented.
 *
 * The row drawer stays: the twelve columns are what you scan, and the drawer is what you read
 * once a row looks worth reading.
 */

const features = tableFeatures({
	columnFilteringFeature,
	globalFilteringFeature,
	rowSortingFeature,
	columnVisibilityFeature,
	filteredRowModel: createFilteredRowModel(),
	sortedRowModel: createSortedRowModel(),
});

const SEVERITY_ORDER: Record<Severity | "none", number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/**
 * Severity of one event, mirroring the ranking the original applied.
 *
 * Injection score is inverted on purpose — Cloudflare scores 1 as most likely an attack and 99
 * as least, so a low score is a high severity. Getting that backwards is the single easiest
 * mistake to make with this field.
 */
export function severityOf(e: RawEvent): Severity | "none" {
	const score = e.injectionScore;
	if (score !== null && score < 20) return "critical";
	if (e.piiCategories.length) return "high";
	if (e.unsafeTopicCategories.length) return "high";
	if (score !== null && score < 40) return "high";
	if (e.customTopics.length) return "medium";
	if (score !== null && score < 80) return "medium";
	return "low";
}

const SEVERITY_CLS: Record<string, string> = {
	// Filled for critical, tonal below it: the rank has to survive being read at a glance and by
	// someone who cannot separate red from amber, so it is carried by weight, not hue alone.
	critical: "bg-rose-600 text-white",
	high: "bg-red-500/15 text-red-600 dark:text-red-400",
	medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	low: "border border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
	none: "border border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
};

function Badge({ severity }: { severity: Severity | "none" }) {
	return (
		<span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${SEVERITY_CLS[severity]}`}>
			{severity}
		</span>
	);
}

const list = (values: string[]) => (values.length ? values.join(", ") : "—");

/** e.g. "UTC+7" — timestamps render in the viewer's zone, Cloudflare's logs are UTC. */
function localOffsetLabel(): string {
	const minutes = -new Date().getTimezoneOffset();
	if (minutes === 0) return "UTC";
	const sign = minutes > 0 ? "+" : "-";
	const abs = Math.abs(minutes);
	const hours = Math.floor(abs / 60);
	const rest = abs % 60;
	return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

export function EventsTable({ events, truncated }: { events: RawEvent[]; truncated: boolean }) {
	const [sorting, setSorting] = useState<SortingState>([{ id: "datetime", desc: true }]);
	const [search, setSearch] = useState(() => {
		// Reproduces the view a "Copy link" URL was taken from.
		const query = window.location.hash.split("?")[1];
		return query ? (new URLSearchParams(query).get("q") ?? "") : "";
	});
	/**
	 * Payload-decryption key. Deliberately component state: it is gone on reload or when the
	 * section unmounts, and it is never written to storage or sent to the Worker.
	 */
	const [privateKey, setPrivateKey] = useState("");
	const [copied, setCopied] = useState(false);
	const [openRay, setOpenRay] = useState<string | null>(null);

	const columns = useMemo<ColumnDef<typeof features, RawEvent>[]>(
		() => [
			{
				id: "datetime",
				header: () => <span>Date / time <span className="font-normal normal-case text-zinc-500 dark:text-zinc-400">{localOffsetLabel()}</span></span>,
				accessorFn: (e) => e.datetime,
				cell: (ctx) => <span className="font-mono text-xs">{new Date(ctx.getValue<string>()).toLocaleString()}</span>,
			},
			{ id: "action", header: "Action", accessorFn: (e) => e.securityAction ?? "—" },
			{
				id: "payloadLog",
				header: "Payload log",
				accessorFn: (e) => (e.payload?.encrypted ? "True" : "False"),
				cell: (ctx) => {
					const on = ctx.getValue<string>() === "True";
					return (
						<span
							className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${
								on
									? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
									: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"
							}`}
						>
							{on ? "True" : "False"}
						</span>
					);
				},
			},
			{
				id: "severity",
				header: "Severity",
				accessorFn: (e) => SEVERITY_ORDER[severityOf(e)],
				cell: (ctx) => <Badge severity={severityOf(ctx.row.original)} />,
				sortDescFirst: true,
			},
			{
				id: "score",
				header: "Injection",
				accessorFn: (e) => e.injectionScore ?? 100,
				cell: (ctx) => <span className="tabular-nums">{ctx.row.original.injectionScore ?? "—"}</span>,
			},
			{ id: "pii", header: "PII", accessorFn: (e) => list(e.piiCategories) },
			{ id: "unsafe", header: "Unsafe topics", accessorFn: (e) => list(e.unsafeTopicCategories) },
			{ id: "custom", header: "Custom topics", accessorFn: (e) => list(e.customTopics.map((c) => c.topicLabel)) },
			{ id: "ip", header: "Source IP", accessorFn: (e) => e.clientIP ?? "—" },
			{ id: "country", header: "Country", accessorFn: (e) => e.country ?? "—" },
			{
				id: "target",
				header: "Target",
				accessorFn: (e) => `${e.host ?? ""}${e.path ?? ""}`,
				cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>() || "—"}</span>,
			},
			{ id: "ray", header: "Ray ID", accessorFn: (e) => e.rayName ?? "—", cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span> },
		],
		[],
	);

	const table = useTable({
		features,
		data: events,
		columns,
		state: { sorting, globalFilter: search },
		onSortingChange: setSorting,
		onGlobalFilterChange: setSearch,
	});

	const rows = table.getRowModel().rows;

	// Exports what is on screen, not the whole fetch: the filters are part of the question being
	// asked, so a CSV that ignored them would not answer it.
	const exportCsv = () => {
		const csv = toCsv(
			rows.map((r) => r.original),
			[
				{ header: "datetime", value: (e) => e.datetime },
				{ header: "zone", value: (e) => e.zoneName },
				{ header: "action", value: (e) => e.securityAction ?? "" },
				{ header: "severity", value: (e) => severityOf(e) },
				{ header: "injection_score", value: (e) => e.injectionScore ?? "" },
				{ header: "pii_categories", value: (e) => e.piiCategories.join("|") },
				{ header: "unsafe_topics", value: (e) => e.unsafeTopicCategories.join("|") },
				{ header: "custom_topics", value: (e) => e.customTopics.map((c) => c.topicLabel).join("|") },
				{ header: "client_ip", value: (e) => e.clientIP ?? "" },
				{ header: "country", value: (e) => e.country ?? "" },
				{ header: "host", value: (e) => e.host ?? "" },
				{ header: "path", value: (e) => e.path ?? "" },
				{ header: "method", value: (e) => e.method ?? "" },
				{ header: "status", value: (e) => e.status ?? "" },
				{ header: "ray_id", value: (e) => e.rayName ?? "" },
			],
		);
		downloadCsv(`ai-security-events-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	};

	return (
		<section className={CARD}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<h2 className={SECTION_TITLE}>Flagged requests</h2>
				<div className="relative ml-auto">
					<SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search IP, target, ray ID, category…"
						aria-label="Search flagged requests"
						className={`w-64 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-2.5 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}
					/>
				</div>
				<button
					type="button"
					onClick={() => setSearch("")}
					disabled={!search}
					className={BTN_SECONDARY}
				>
					Reset
				</button>
				<button
					type="button"
					onClick={() => {
						// The search text can name an IP or a host, so it is only put in the link
						// when it is actually set — a shared link should not carry a filter the
						// sender did not deliberately apply.
						const url = new URL(window.location.href);
						const [route, query] = url.hash.replace(/^#/, "").split("?");
						const params = new URLSearchParams(query ?? "");
						if (search.trim()) params.set("q", search.trim());
						else params.delete("q");
						const qs = params.toString();
						url.hash = `#${route}${qs ? `?${qs}` : ""}`;
						void navigator.clipboard?.writeText(url.toString()).then(
							() => setCopied(true),
							() => setCopied(false),
						);
					}}
					className={BTN_SECONDARY}
				>
					{copied ? "Copied" : "Copy link"}
				</button>
				<button
					type="button"
					onClick={exportCsv}
					disabled={!rows.length}
					className={BTN_SECONDARY}
				>
					Export CSV
				</button>
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{rows.length.toLocaleString()} of {events.length.toLocaleString()}
				</span>
			</div>

			<p className="mb-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
				Showing {events.length.toLocaleString()} flagged request(s). Every event lists the rule that fired and the
				fields it matched — often enough to judge a false positive without reading the prompt at all.
			</p>

			<DecryptKeyPanel privateKey={privateKey} onChange={setPrivateKey} />

			{truncated && (
				<p className={`mb-3 ${ALERT_WARN}`}>
					The event list was truncated for this window — narrow the range for a complete set.
				</p>
			)}

			{!events.length ? (
				<EmptyNote title="No flagged requests in this window" />
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[1240px] border-collapse text-sm">
						<thead>
							{table.getHeaderGroups().map((group) => (
								<tr key={group.id} className="border-b border-zinc-200 dark:border-zinc-800">
									<th className="w-6 px-1 py-2">
										<span className="sr-only">Expand row</span>
									</th>
									{group.headers.map((header) => {
										const sorted = header.column.getIsSorted();
										return (
											<th key={header.id} className="whitespace-nowrap px-2 py-2 text-left">
												<button
													type="button"
													onClick={header.column.getToggleSortingHandler()}
													className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
												>
													{flexRender(header.column.columnDef.header, header.getContext())}
													{sorted === "asc" && <ChevronUpIcon size={12} />}
													{sorted === "desc" && <ChevronDownIcon size={12} />}
												</button>
											</th>
										);
									})}
								</tr>
							))}
						</thead>
						<tbody>
							{rows.map((row) => {
								const e = row.original;
								const key = e.rayName ?? `${e.datetime}|${e.clientIP}`;
								const open = openRay === key;
								return (
									<Fragment key={key}>
									<tr
										onClick={() => setOpenRay(open ? null : key)}
										className={`cursor-pointer border-b border-zinc-100 transition dark:border-zinc-800/60 ${
											open ? "bg-zinc-50 dark:bg-zinc-800/50" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
										}`}
									>
										<td className="px-1 py-2 align-middle">
											{/* The button carries the semantics: a clickable <tr> is not focusable, so
											    keyboard users would otherwise have no way to open a row. */}
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													setOpenRay(open ? null : key);
												}}
												aria-expanded={open}
												aria-label={open ? "Collapse event details" : "Expand event details"}
												className="rounded p-0.5 text-zinc-500 dark:text-zinc-400 transition hover:text-zinc-700 dark:hover:text-zinc-200"
											>
												{open ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
											</button>
										</td>
										{row.getVisibleCells().map((cell) => (
											<td
												key={cell.id}
												className="max-w-[14rem] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 align-middle"
											>
												{flexRender(cell.column.columnDef.cell ?? ((c) => String(c.getValue() ?? "")), cell.getContext())}
											</td>
										))}
									</tr>
									{open && (
										<tr className="border-b border-zinc-100 dark:border-zinc-800/60">
											<td colSpan={columns.length + 1} className="p-0">
											<dl className="grid grid-cols-[170px_1fr] gap-x-3 gap-y-1 rounded-lg bg-zinc-50 px-3 py-3 text-sm dark:bg-zinc-800/50">
												<dt className="text-zinc-500 dark:text-zinc-400">Zone</dt>
												<dd>{e.zoneName}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Ray ID</dt>
												<dd className="font-mono text-xs">{e.rayName ?? "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Severity</dt>
												<dd><Badge severity={severityOf(e)} /></dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Injection score</dt>
												<dd>{e.injectionScore ?? "—"} <span className="text-zinc-500">(1–99, lower is more likely an attack; 100 = not scored)</span></dd>
												<dt className="text-zinc-500 dark:text-zinc-400">PII categories</dt>
												<dd>{list(e.piiCategories)}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Unsafe topics</dt>
												<dd>{list(e.unsafeTopicCategories)}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Custom topics</dt>
												<dd>
													{e.customTopics.length ? e.customTopics.map((c) => `${c.topicLabel} (${c.score})`).join(", ") : "—"}{" "}
													<span className="text-zinc-500">(1–99, lower is a stronger match; 100 = no match)</span>
												</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Token count</dt>
												<dd>{e.tokenCount ?? "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Request</dt>
												<dd className="break-all">{e.method ?? "?"} {e.host ?? ""}{e.path ?? ""} → {e.status ?? "?"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Endpoint ID</dt>
												<dd className="break-all font-mono text-xs">
													{e.operationId ?? "—"}{e.operationId && <span className="ml-1 font-sans text-zinc-500">(API Shield operation ID, for correlation only)</span>}
												</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Source</dt>
												<dd className="break-all">{[e.clientIP, e.country, e.asnDescription].filter(Boolean).join(" · ") || "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">JA4</dt>
												<dd className="font-mono text-xs">{e.ja4 ?? "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Security action</dt>
												<dd>{e.securityAction ?? "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Sample interval</dt>
												<dd>
													{e.sampleInterval} <span className="text-zinc-500">(this row represents {e.sampleInterval} request(s))</span>
												</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Rules fired</dt>
												<dd>{e.payload ? list(e.payload.rules) : "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Matched fields</dt>
												<dd className="break-all font-mono text-xs">{e.payload ? list(e.payload.matchedVars) : "—"}</dd>
												<dt className="text-zinc-500 dark:text-zinc-400">Prompt payload</dt>
												<dd>
													{e.payload?.encrypted ? (
														<PromptPayload ciphertext={e.payload.encrypted} privateKey={privateKey} />
													) : (
														<span className="text-zinc-500 dark:text-zinc-400">Not logged.</span>
													)}
												</dd>
											</dl>
											</td>
										</tr>
									)}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

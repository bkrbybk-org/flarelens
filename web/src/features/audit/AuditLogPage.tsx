import { useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { useHashSyncedState } from "../../hooks/useHashParams";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { SearchIcon } from "../../components/Icons";
import { ALERT_ERROR, ALERT_WARN, BADGE, BADGE_NEUTRAL, BTN_SECONDARY, CARD, MUTED, SEARCH_INPUT, SECTION_TITLE, SELECT } from "../../lib/ui";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { useAuditLog } from "./useAuditLog";
import { contextLabel, summarise, type AuditEvent } from "./types";

/** The worker refuses a wider window; see MAX_AUDIT_RANGE_MS in src/lib/audit-log.ts. */
const MAX_MINUTES = 30 * 24 * 60;
/** Rows rendered before "Show more" — a busy week is thousands of events. */
const PAGE = 200;

function ActionBadge({ type }: { type: string }) {
	const tone =
		type === "delete"
			? "bg-red-500/10 text-red-600 dark:text-red-400"
			: type === "create"
				? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
				: type === "update"
					? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
					: BADGE_NEUTRAL;
	return <span className={`${BADGE} ${tone}`}>{type || "—"}</span>;
}

function when(iso: string): string {
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

function matches(e: AuditEvent, q: string): boolean {
	if (!q) return true;
	return [e.description, e.actor.label, e.resource.product, e.resource.type, e.resource.id, e.zone?.name ?? "", e.uri]
		.join(" ")
		.toLowerCase()
		.includes(q);
}

export function AuditLogPage({ session, timeRange, onAuthError }: { session: Session; timeRange: TimeRange; onAuthError: () => void }) {
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useAuditLog(onAuthError);
	useSectionRefresh(useCallback(() => setReloadKey((k) => k + 1), []), loading);

	const { minutes, clamped } = timeRange.clamp(MAX_MINUTES);
	const { from, to } = timeRange.bounds(MAX_MINUTES);

	useEffect(() => {
		load(session.token, session.accountId, from, to);
		// `from`/`to` are recomputed per render; the window itself is what should retrigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, minutes, reloadKey, load]);

	const [search, setSearch] = useState("");
	const [actionType, setActionType] = useState("");
	const [outcome, setOutcome] = useState("");
	const [product, setProduct] = useState("");
	useHashSyncedState("q", search, setSearch, "audit");
	useHashSyncedState("au_type", actionType, setActionType, "audit");
	useHashSyncedState("au_result", outcome, setOutcome, "audit");
	useHashSyncedState("au_product", product, setProduct, "audit");
	const [showReads, setShowReads] = useState(false);
	const [shown, setShown] = useState(PAGE);

	const all = useMemo(() => result?.events ?? [], [result]);
	const changes = useMemo(() => (showReads ? all : all.filter((e) => !e.readOnly)), [all, showReads]);
	const hiddenReads = all.length - all.filter((e) => !e.readOnly).length;
	const summary = useMemo(() => summarise(changes), [changes]);

	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		return changes.filter(
			(e) =>
				(!actionType || e.actionType === actionType) &&
				(!outcome || e.result === outcome) &&
				(!product || e.resource.product === product) &&
				matches(e, q),
		);
	}, [changes, search, actionType, outcome, product]);

	const exportCsv = () =>
		downloadCsv(
			"flarelens-audit-log.csv",
			toCsv(rows, [
				{ header: "Time", value: (e) => e.time },
				{ header: "Actor", value: (e) => e.actor.label },
				{ header: "Via", value: (e) => contextLabel(e.actor.context) },
				{ header: "Action", value: (e) => e.actionType },
				{ header: "Description", value: (e) => e.description },
				{ header: "Product", value: (e) => e.resource.product },
				{ header: "Resource type", value: (e) => e.resource.type },
				{ header: "Resource id", value: (e) => e.resource.id },
				{ header: "Zone", value: (e) => e.zone?.name ?? "" },
				{ header: "Result", value: (e) => e.result },
				{ header: "Request", value: (e) => `${e.method} ${e.uri}`.trim() },
			]),
		);

	return (
		<PageShell progress={progress}>
			<p className={`text-xs ${MUTED}`}>
				Cloudflare's account audit log, newest first: who changed what, when, and whether it worked. Actor IP addresses and the
				changed values themselves are not shown — this answers "who and what", not "to what".
			</p>

			{clamped && (
				<div role="status" className={ALERT_WARN}>
					The audit log is read for at most 30 days — showing the last 30.
				</div>
			)}
			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}
			{result?.truncated && (
				<div role="status" className={ALERT_WARN}>
					This window holds more than {all.length.toLocaleString()} events; only the newest are shown. Shorten the range to see all of it.
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard label="Changes" value={summary.changes} hint={hiddenReads && !showReads ? `${hiddenReads.toLocaleString()} read-only queries hidden` : undefined} />
				<StatCard label="Failed" value={summary.failures} tone={summary.failures ? "text-amber-700 dark:text-amber-400" : undefined} hint="refused or errored" />
				<StatCard label="Deletions" value={summary.deletes} tone={summary.deletes ? "text-red-600 dark:text-red-400" : undefined} />
				<StatCard label="Actors" value={summary.actors} hint={summary.byActor[0] ? `most active: ${summary.byActor[0][0]}` : undefined} />
			</StatGrid>

			<section className={CARD}>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<h2 className={`mr-auto ${SECTION_TITLE}`}>Events</h2>
					<div className="relative min-w-0 basis-56">
						<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
						<label htmlFor="audit-search" className="sr-only">Search events</label>
						<input
							id="audit-search"
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search actor, resource, zone…"
							className={SEARCH_INPUT}
						/>
					</div>
					<select aria-label="Filter by action" value={actionType} onChange={(e) => setActionType(e.target.value)} className={SELECT}>
						<option value="">All actions</option>
						<option value="create">Create</option>
						<option value="update">Update</option>
						<option value="delete">Delete</option>
					</select>
					<select aria-label="Filter by result" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={SELECT}>
						<option value="">All results</option>
						<option value="success">Succeeded</option>
						<option value="failure">Failed</option>
					</select>
					<select aria-label="Filter by product" value={product} onChange={(e) => setProduct(e.target.value)} className={SELECT}>
						<option value="">All products</option>
						{summary.byProduct.map(([name, count]) => (
							<option key={name} value={name === "—" ? "" : name}>
								{name} ({count})
							</option>
						))}
					</select>
					<label className="flex items-center gap-1.5 text-xs">
						<input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} />
						Include dashboard analytics queries
					</label>
					<button type="button" className={BTN_SECONDARY} onClick={exportCsv} disabled={!rows.length}>
						Export CSV
					</button>
				</div>

				{rows.length === 0 ? (
					<EmptyNote loading={loading && !all.length} title={all.length ? "No event matches these filters." : "No changes in this window."} />
				) : (
					<>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className={`text-left text-xs ${MUTED}`}>
										<th className="py-2 pr-3 font-medium">When</th>
										<th className="py-2 pr-3 font-medium">Who</th>
										<th className="py-2 pr-3 font-medium">Action</th>
										<th className="py-2 pr-3 font-medium">Resource</th>
										<th className="py-2 pr-3 font-medium">Zone</th>
										<th className="py-2 font-medium">Result</th>
									</tr>
								</thead>
								<tbody>
									{rows.slice(0, shown).map((e) => (
										<tr key={e.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
											<td className="whitespace-nowrap py-1.5 pr-3 text-xs tabular-nums" title={e.time}>{when(e.time)}</td>
											<td className="py-1.5 pr-3">
												<div className="max-w-[16rem] truncate" title={e.actor.label}>{e.actor.label}</div>
												<div className={`text-xs ${MUTED}`}>{contextLabel(e.actor.context)}</div>
											</td>
											<td className="py-1.5 pr-3">
												<div className="flex items-center gap-2">
													<ActionBadge type={e.actionType} />
													<span>{e.description}</span>
												</div>
											</td>
											<td className="py-1.5 pr-3">
												<div className="text-xs">{[e.resource.product, e.resource.type].filter(Boolean).join(" · ") || "—"}</div>
												{e.resource.id && <div className={`max-w-[14rem] truncate font-mono text-xs ${MUTED}`} title={e.resource.id}>{e.resource.id}</div>}
											</td>
											<td className="py-1.5 pr-3 text-xs">{e.zone?.name ?? <span className={MUTED}>account</span>}</td>
											<td className="py-1.5 text-xs">
												{e.result === "failure" ? (
													<span className="text-amber-700 dark:text-amber-400" title={e.statusCode ? `HTTP ${e.statusCode}` : undefined}>failed</span>
												) : (
													<span className={MUTED}>{e.result || "—"}</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{rows.length > shown && (
							<button type="button" className={`${BTN_SECONDARY} mt-3`} onClick={() => setShown((n) => n + PAGE)}>
								Show {Math.min(PAGE, rows.length - shown).toLocaleString()} more of {(rows.length - shown).toLocaleString()}
							</button>
						)}
					</>
				)}
			</section>
		</PageShell>
	);
}

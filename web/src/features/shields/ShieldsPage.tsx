import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { useHashSyncedState } from "../../hooks/useHashParams";
import { useZones } from "../../hooks/useZones";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { TabPanel, Tabs } from "../../components/Tabs";
import { ALERT_ERROR, ALERT_WARN, BADGE, BTN_SECONDARY, CARD, MUTED, SEARCH_INPUT, SECTION_TITLE, SELECT } from "../../lib/ui";
import { SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import { cacheAgeLabel } from "../../lib/edge-cache-caption";
import type { Session } from "../../hooks/useSession";
import { useShieldsReport } from "./useShieldsReport";
import type { PsItem, PsList, ShieldFinding, ShieldSeverity, ZoneApiShield, ZoneShields } from "./types";

type Tab = "page-shield" | "api-shield" | "findings";

const SEVERITY_ORDER: Record<ShieldSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const SEVERITY_TONE: Record<ShieldSeverity, string> = {
	high: "bg-red-500/10 text-red-600 dark:text-red-400",
	medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
	info: "bg-cf/10 text-cf",
};

interface ScriptRow extends PsItem {
	zoneId: string;
	zoneName: string;
	kind: "script" | "connection";
}

/**
 * Third-party host rendered as plain text, never a link.
 *
 * These strings come from client-side scripts and connections Page Shield observed on someone
 * else's page — third-party-controlled, not something this app chose to link to. A clickable
 * link that auto-navigates on a malicious or typo-squatted host is its own risk; the operator can
 * copy the text and decide for themselves.
 */
function HostText({ value }: { value: string }) {
	return <span className="break-all">{value || <span className={MUTED}>—</span>}</span>;
}

function PageShieldZoneStatus({ zone }: { zone: ZoneShields }) {
	const { status, policies, scripts } = zone.pageShield;
	return (
		<div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
			<div className="mb-1 flex flex-wrap items-center gap-2">
				<span className="text-sm font-medium">{zone.zoneName}</span>
				{status.available ? (
					<span className={`${BADGE} ${status.enabled ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"}`}>
						{status.enabled ? "Enabled" : "Disabled"}
					</span>
				) : (
					<span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`}>Not checked</span>
				)}
			</div>
			{!status.available && <p className={MUTED}>{status.reason}</p>}
			{status.available && (
				<p className={MUTED}>
					{policies.available ? `${policies.items.length} polic${policies.items.length === 1 ? "y" : "ies"}` : "Policies: not checked"}
					{" · "}
					{scripts.available ? `${scripts.totalSeen} script${scripts.totalSeen === 1 ? "" : "s"}` : "Scripts: not checked"}
				</p>
			)}
		</div>
	);
}

function ApiShieldReadCell({ label, available, reason, value }: { label: string; available: boolean; reason?: string; value: string }) {
	return (
		<div>
			<div className={`text-xs font-medium uppercase tracking-wide ${MUTED}`}>{label}</div>
			{available ? <div className="text-sm">{value}</div> : <div className="text-xs text-amber-700 dark:text-amber-400">Not checked — {reason}</div>}
		</div>
	);
}

function ApiShieldZoneCard({ zone }: { zone: ZoneShields }) {
	const a: ZoneApiShield = zone.apiShield;
	return (
		<div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<span className="text-sm font-medium">{zone.zoneName}</span>
				<span className={`${BADGE} ${a.fullyChecked ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
					{a.fullyChecked ? "Fully checked" : "Not fully checked"}
				</span>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<ApiShieldReadCell label="Saved endpoints" available={a.operations.available} reason={a.operations.reason} value={String(a.operations.savedCount)} />
				<ApiShieldReadCell label="Discovered, not saved" available={a.discovery.available} reason={a.discovery.reason} value={String(a.discovery.discoveredNotSavedCount)} />
				<ApiShieldReadCell
					label="Schema validation"
					available={a.schemaValidation.available}
					reason={a.schemaValidation.reason}
					value={a.schemaValidation.defaultAction ?? "none"}
				/>
				<ApiShieldReadCell label="Uploaded schemas" available={a.userSchemas.available} reason={a.userSchemas.reason} value={String(a.userSchemas.count)} />
				<ApiShieldReadCell
					label="Session identifier"
					available={a.configuration.available}
					reason={a.configuration.reason}
					value={a.configuration.sessionIdentifierConfigured ? "Configured" : "Not configured"}
				/>
			</div>
		</div>
	);
}

export function ShieldsPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [tab, setTab] = useState<Tab>("page-shield");
	const [zoneFilter, setZoneFilter] = useState("");
	const [search, setSearch] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, cachedAt, progress, load } = useShieldsReport(onAuthError);
	const zones = useZones();

	useHashSyncedState("tab", tab, (v) => setTab(v as Tab), "shields");
	// Own key, not "zone": that name drives the account-wide zone-scope selector other routes
	// (waf/cache/ai-security/bots) share via App.tsx's zonePicker/prefs, and this page's zone
	// narrowing is local to Shields, fetched through zone_id rather than filtered client-side.
	useHashSyncedState("sh_zone", zoneFilter, setZoneFilter, "shields");

	const freshOnNextLoadRef = useRef(false);
	useSectionRefresh(
		useCallback(() => {
			freshOnNextLoadRef.current = true;
			setReloadKey((k) => k + 1);
		}, []),
		loading,
	);

	const ensureZonesLoaded = zones.ensureLoaded;
	useEffect(() => {
		if (session.accountId) ensureZonesLoaded(session.token, session.accountId);
	}, [session.token, session.accountId, ensureZonesLoaded]);

	useEffect(() => {
		const fresh = freshOnNextLoadRef.current;
		freshOnNextLoadRef.current = false;
		load(session.token, session.accountId, zoneFilter || undefined, fresh);
	}, [session.token, session.accountId, zoneFilter, reloadKey, load]);

	const zoneOptions = useMemo(
		() => [...zones.zones].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
		[zones.zones],
	);

	const scriptRows = useMemo<ScriptRow[]>(() => {
		const rows: ScriptRow[] = [];
		for (const zone of result?.zones ?? []) {
			const lists: [PsList, "script" | "connection"][] = [
				[zone.pageShield.scripts, "script"],
				[zone.pageShield.connections, "connection"],
			];
			for (const [list, kind] of lists) {
				if (!list.available) continue;
				for (const item of list.items) {
					rows.push({ ...item, zoneId: zone.zoneId, zoneName: zone.zoneName, kind });
				}
			}
		}
		return rows;
	}, [result]);

	const filteredScriptRows = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return scriptRows;
		return scriptRows.filter((r) => `${r.host} ${r.url} ${r.zoneName} ${r.status}`.toLowerCase().includes(q));
	}, [scriptRows, search]);

	const findings = useMemo<ShieldFinding[]>(() => {
		const rows = [...(result?.findings ?? [])];
		rows.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.zoneName.localeCompare(b.zoneName));
		return rows;
	}, [result]);

	const totals = result?.totals ?? {
		zones: 0,
		pageShieldEnabledZones: 0,
		scripts: 0,
		connections: 0,
		maliciousFlags: 0,
		apiShieldCheckedZones: 0,
		apiShieldNotCheckedZones: 0,
		findings: { high: 0, medium: 0, low: 0, info: 0 },
	};

	function exportScriptsCsv() {
		const csv = toCsv(filteredScriptRows, [
			{ header: "zone", value: (r) => r.zoneName },
			{ header: "kind", value: (r) => r.kind },
			{ header: "host", value: (r) => r.host },
			{ header: "url", value: (r) => r.url },
			{ header: "status", value: (r) => r.status },
			{ header: "first_seen_at", value: (r) => r.firstSeenAt ?? "" },
			{ header: "last_seen_at", value: (r) => r.lastSeenAt ?? "" },
			{ header: "page_count", value: (r) => r.pageUrls.length },
			{ header: "third_party", value: (r) => (r.thirdParty ? "true" : "false") },
			{ header: "domain_reported_malicious", value: (r) => (r.domainReportedMalicious ? "true" : "false") },
			{ header: "url_reported_malicious", value: (r) => (r.urlReportedMalicious ? "true" : "false") },
		]);
		downloadCsv(`shields-scripts-connections-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	function exportFindingsCsv() {
		const csv = toCsv(findings, [
			{ header: "severity", value: (r) => r.severity },
			{ header: "zone", value: (r) => r.zoneName },
			{ header: "source", value: (r) => r.source },
			{ header: "title", value: (r) => r.title },
			{ header: "detail", value: (r) => r.detail },
		]);
		downloadCsv(`shields-findings-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<PageShell progress={progress}>
			{cachedAt && <p className={`text-xs ${MUTED}`}>{cacheAgeLabel(cachedAt)}</p>}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{result?.errors.map((e) => (
				<div key={e.source} role="status" className={ALERT_WARN}>
					{e.source}: {e.message}
				</div>
			))}

			<div className="flex flex-wrap items-center gap-2">
				<select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} aria-label="Filter by zone" className={SELECT}>
					<option value="">Account (all zones)</option>
					{zoneOptions.map((z) => (
						<option key={z.id} value={z.id}>
							{z.name || z.id}
						</option>
					))}
				</select>
			</div>

			<StatGrid cols={5}>
				<StatCard label="Page Shield on" value={totals.pageShieldEnabledZones} hint={`of ${totals.zones} zone${totals.zones === 1 ? "" : "s"}`} />
				<StatCard label="Scripts" value={totals.scripts} hint="observed by Page Shield" />
				<StatCard label="Connections" value={totals.connections} hint="observed by Page Shield" />
				<StatCard label="Malicious flags" value={totals.maliciousFlags} tone={totals.maliciousFlags ? "text-red-600 dark:text-red-400" : undefined} hint="domain or URL reported malicious" />
				<StatCard
					label="API Shield checked"
					value={`${totals.apiShieldCheckedZones}/${totals.zones}`}
					tone={totals.apiShieldNotCheckedZones ? "text-amber-700 dark:text-amber-400" : undefined}
					hint="zones with every read readable"
				/>
			</StatGrid>

			<Tabs<Tab>
				label="Shields sections"
				idPrefix="shields"
				active={tab}
				onChange={setTab}
				tabs={[
					{ id: "page-shield", label: "Page Shield" },
					{ id: "api-shield", label: "API Shield" },
					{ id: "findings", label: `Findings (${findings.length})` },
				]}
			/>

			{tab === "page-shield" && (
			<TabPanel id="page-shield" idPrefix="shields">
				<div className="space-y-4">
				<section className={CARD}>
					<h2 className={`mb-3 ${SECTION_TITLE}`}>Page Shield status</h2>
					{(result?.zones ?? []).length === 0 ? (
						<EmptyNote title="No zones yet" loading={loading} />
					) : (
						<div className="space-y-2">
							{(result?.zones ?? []).map((zone) => (
								<PageShieldZoneStatus key={zone.zoneId} zone={zone} />
							))}
						</div>
					)}
				</section>

				<section className={CARD}>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 className={SECTION_TITLE}>Scripts & connections</h2>
						<div className="flex flex-wrap items-center gap-2">
							<div className="relative min-w-0 flex-1 basis-64">
								<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
								<input
									type="search"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search host, URL, zone…"
									aria-label="Search scripts and connections"
									className={SEARCH_INPUT}
								/>
							</div>
							<button type="button" onClick={exportScriptsCsv} disabled={!filteredScriptRows.length} className={BTN_SECONDARY}>
								Export CSV
							</button>
						</div>
					</div>

					{scriptRows.length === 0 ? (
						<EmptyNote title="No scripts or connections observed" loading={loading} />
					) : filteredScriptRows.length === 0 ? (
						<EmptyNote title="No matching rows" loading={loading} />
					) : (
						<div className="mt-3 overflow-x-auto">
							<table className="w-full text-sm">
								<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
									<tr>
										<th className="py-1.5 pr-3 font-medium">Zone</th>
										<th className="py-1.5 pr-3 font-medium">Kind</th>
										<th className="py-1.5 pr-3 font-medium">Host</th>
										<th className="py-1.5 pr-3 font-medium">First / last seen</th>
										<th className="py-1.5 pr-3 font-medium">Status</th>
										<th className="py-1.5 pr-3 font-medium">Flags</th>
									</tr>
								</thead>
								<tbody>
									{filteredScriptRows.map((row, i) => (
										<tr key={`${row.zoneId}|${row.kind}|${row.id}|${i}`} className="border-t border-zinc-100 align-top dark:border-zinc-800">
											<td className="py-1.5 pr-3">{row.zoneName}</td>
											<td className="py-1.5 pr-3">{row.kind}</td>
											<td className="py-1.5 pr-3 font-mono text-xs">
												<HostText value={row.host} />
												{row.thirdParty && <span className={`ml-1 ${BADGE} bg-zinc-500/10 text-zinc-500 dark:text-zinc-400`}>third-party</span>}
											</td>
											<td className="py-1.5 pr-3 text-xs">
												{row.firstSeenAt ? new Date(row.firstSeenAt).toLocaleDateString() : "—"} / {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString() : "—"}
											</td>
											<td className="py-1.5 pr-3 text-xs">{row.status}</td>
											<td className="py-1.5 pr-3">
												{(row.domainReportedMalicious || row.urlReportedMalicious) && (
													<span className={`${BADGE} ${SEVERITY_TONE.high}`}>malicious</span>
												)}
												{row.newThirdParty && <span className={`ml-1 ${BADGE} ${SEVERITY_TONE.info}`}>new</span>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
				</div>
			</TabPanel>
			)}

			{tab === "api-shield" && (
			<TabPanel id="api-shield" idPrefix="shields">
				<section className={CARD}>
					<h2 className={`mb-2 ${SECTION_TITLE}`}>API Shield</h2>
					<p className={`mb-3 text-xs ${MUTED}`}>
						Every read here needs its own scope. A zone that shows "not checked" is missing that permission (or the feature
						is not on that plan) — it is never the same as a zone with zero endpoints or schemas.
					</p>
					{(result?.zones ?? []).length === 0 ? (
						<EmptyNote title="No zones yet" loading={loading} />
					) : (
						<div className="space-y-3">
							{(result?.zones ?? []).map((zone) => (
								<ApiShieldZoneCard key={zone.zoneId} zone={zone} />
							))}
						</div>
					)}
				</section>
			</TabPanel>
			)}

			{tab === "findings" && (
			<TabPanel id="findings" idPrefix="shields">
				<section className={CARD}>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 className={SECTION_TITLE}>Findings</h2>
						<button type="button" onClick={exportFindingsCsv} disabled={!findings.length} className={BTN_SECONDARY}>
							Export CSV
						</button>
					</div>
					{findings.length === 0 ? (
						<EmptyNote title="No findings" loading={loading} />
					) : (
						<div className="mt-3 overflow-x-auto">
							<table className="w-full text-sm">
								<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
									<tr>
										<th className="py-1.5 pr-3 font-medium">Severity</th>
										<th className="py-1.5 pr-3 font-medium">Zone</th>
										<th className="py-1.5 pr-3 font-medium">Source</th>
										<th className="py-1.5 pr-3 font-medium">Finding</th>
									</tr>
								</thead>
								<tbody>
									{findings.map((f, i) => (
										<tr key={`${f.zoneId}|${f.title}|${i}`} className="border-t border-zinc-100 align-top dark:border-zinc-800">
											<td className="py-1.5 pr-3">
												<span className={`${BADGE} uppercase ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span>
											</td>
											<td className="py-1.5 pr-3">{f.zoneName}</td>
											<td className="py-1.5 pr-3 text-xs">{f.source === "page-shield" ? "Page Shield" : "API Shield"}</td>
											<td className="py-1.5 pr-3">
												<div className="font-medium">{f.title}</div>
												<div className={`text-xs ${MUTED}`}>{f.detail}</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</TabPanel>
			)}
		</PageShell>
	);
}

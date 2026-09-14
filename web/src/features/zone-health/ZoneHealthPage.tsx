import { useCallback, useEffect, useMemo, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, BADGE, BTN_SECONDARY, CARD, MUTED, SEARCH_INPUT, SECTION_TITLE } from "../../lib/ui";
import { SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { Session } from "../../hooks/useSession";
import { useZoneHealthReport } from "./useZoneHealthReport";
import type { CertSource, DnsFinding, DnsSeverity, DnsUnknown, ZoneCertificates, ZoneHealth } from "./types";

const DNS_SEVERITY_ORDER: Record<DnsSeverity, number> = { high: 0, medium: 1, low: 2 };

const DNS_SEVERITY_TONE: Record<DnsSeverity, string> = {
	high: "bg-red-500/10 text-red-600 dark:text-red-400",
	medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
};

const CERT_SOURCE_LABEL = { edge: "Edge (managed)", custom: "Custom (uploaded)", originCa: "Origin CA" } as const;

interface DnsRow extends DnsFinding {
	zoneId: string;
	zoneName: string;
}

interface UnknownRow extends DnsUnknown {
	zoneId: string;
	zoneName: string;
}

/**
 * One certificate source's card body.
 *
 * `available: false` is rendered as its own state — "not checked" plus the reason — rather than
 * folded into "0 certificates found". Cloudflare returning 9109 for a missing scope must never
 * look the same as a zone that genuinely has none.
 */
function CertSourcePanel({ label, source }: { label: string; source: CertSource }) {
	if (!source.available) {
		return (
			<div className={ALERT_WARN}>
				<span className="font-medium">{label}: not checked.</span> {source.reason}
			</div>
		);
	}
	const flagged = source.items.filter((item) => item.severity !== null);
	if (flagged.length === 0) {
		return (
			<p className={`text-xs ${MUTED}`}>
				{label}: checked, {source.items.length} certificate{source.items.length === 1 ? "" : "s"} — no findings.
			</p>
		);
	}
	return (
		<div>
			<div className="mb-1 text-xs font-medium">{label}</div>
			<ul className="space-y-1.5">
				{flagged.map((item) => (
					<li key={item.id} className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs dark:border-zinc-800">
						<div className="flex flex-wrap items-center gap-2">
							<span className={`${BADGE} uppercase ${item.severity === "high" ? DNS_SEVERITY_TONE.high : DNS_SEVERITY_TONE.medium}`}>
								{item.severity}
							</span>
							<span className="font-medium">{item.title}</span>
							{item.hosts.length > 0 && <span className={MUTED}>{item.hosts.join(", ")}</span>}
						</div>
						<p className={`mt-0.5 ${MUTED}`}>{item.detail}</p>
					</li>
				))}
			</ul>
		</div>
	);
}

function ZoneCertCard({ zone }: { zone: ZoneHealth }) {
	const certs: ZoneCertificates = zone.certificates;
	return (
		<div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
			<div className="mb-2 text-sm font-medium">{zone.zoneName}</div>
			<div className="space-y-2">
				<CertSourcePanel label={CERT_SOURCE_LABEL.edge} source={certs.edge} />
				<CertSourcePanel label={CERT_SOURCE_LABEL.custom} source={certs.custom} />
				<CertSourcePanel label={CERT_SOURCE_LABEL.originCa} source={certs.originCa} />
			</div>
		</div>
	);
}

export function ZoneHealthPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useZoneHealthReport(onAuthError);
	useSectionRefresh(useCallback(() => setReloadKey((k) => k + 1), []), loading);

	useEffect(() => {
		load(session.token, session.accountId);
	}, [session.token, session.accountId, reloadKey, load]);

	const dnsRows = useMemo<DnsRow[]>(() => {
		const rows: DnsRow[] = [];
		for (const zone of result?.zones ?? []) {
			for (const finding of zone.dns.findings) {
				rows.push({ ...finding, zoneId: zone.zoneId, zoneName: zone.zoneName });
			}
		}
		rows.sort((a, b) => DNS_SEVERITY_ORDER[a.severity] - DNS_SEVERITY_ORDER[b.severity] || a.record.name.localeCompare(b.record.name));
		return rows;
	}, [result]);

	const unknownRows = useMemo<UnknownRow[]>(() => {
		const rows: UnknownRow[] = [];
		for (const zone of result?.zones ?? []) {
			for (const u of zone.dns.unknown) {
				rows.push({ ...u, zoneId: zone.zoneId, zoneName: zone.zoneName });
			}
		}
		return rows;
	}, [result]);

	const filteredDnsRows = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return dnsRows;
		return dnsRows.filter((r) => `${r.record.name} ${r.zoneName} ${r.title} ${r.detail}`.toLowerCase().includes(q));
	}, [dnsRows, search]);

	const totals = result?.totals ?? { zones: 0, findings: { high: 0, medium: 0, low: 0 }, unknown: 0 };
	const recordsChecked = (result?.zones ?? []).reduce((sum, z) => sum + z.dns.checked.records, 0);

	/**
	 * What the DNS card says when it has no findings.
	 *
	 * "Clean" is only true of what was checked. If some records or whole zones could not be read,
	 * saying "no findings" without qualification would present an unchecked zone as a passing one —
	 * so the count of what was not checked is part of the sentence, not a footnote below it.
	 */
	const cleanDnsTitle = (() => {
		const unchecked = unknownRows.length;
		if (recordsChecked === 0 && unchecked > 0) return "No DNS records could be checked — see “Unable to check” below.";
		const base = `No findings in ${recordsChecked.toLocaleString()} DNS record${recordsChecked === 1 ? "" : "s"} checked across ${totals.zones} zone${totals.zones === 1 ? "" : "s"}.`;
		return unchecked > 0 ? `${base} ${unchecked} could not be checked — listed below, not counted as clean.` : base;
	})();

	function exportCsv() {
		const csv = toCsv(filteredDnsRows, [
			{ header: "zone", value: (r) => r.zoneName },
			{ header: "severity", value: (r) => r.severity },
			{ header: "record_name", value: (r) => r.record.name },
			{ header: "record_type", value: (r) => r.record.type },
			{ header: "record_content", value: (r) => r.record.content },
			{ header: "title", value: (r) => r.title },
			{ header: "detail", value: (r) => r.detail },
		]);
		downloadCsv(`zone-health-dns-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<PageShell progress={progress}>
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

			<StatGrid cols={4}>
				<StatCard label="High" value={totals.findings.high} tone={totals.findings.high ? "text-red-600 dark:text-red-400" : undefined} hint="expired or about to break" />
				<StatCard label="Medium" value={totals.findings.medium} tone={totals.findings.medium ? "text-amber-700 dark:text-amber-400" : undefined} hint="needs attention soon" />
				<StatCard label="Low" value={totals.findings.low} hint="hygiene, worth a look" />
				<StatCard label="Unknown checks" value={totals.unknown} tone={totals.unknown ? "text-amber-700 dark:text-amber-400" : undefined} hint="could not be read — not a pass" />
			</StatGrid>

			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Certificates</h2>
				<p className={`mb-3 text-xs ${MUTED}`}>
					Three sources per zone, checked independently: edge (managed) certificate packs auto-renew and are held to the
					tightest window; custom uploaded certificates and Origin CA certificates are renewed by hand. A source Cloudflare
					refuses to return is reported as not checked, with the missing permission named — never as an empty, clean list.
				</p>
				{(result?.zones ?? []).length === 0 ? (
					<EmptyNote title="No zones yet" loading={loading} />
				) : (
					<div className="space-y-3">
						{(result?.zones ?? []).map((zone) => (
							<ZoneCertCard key={zone.zoneId} zone={zone} />
						))}
					</div>
				)}
			</section>

			<section className={CARD}>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className={SECTION_TITLE}>DNS hygiene</h2>
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-0 flex-1 basis-72">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
							<input
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search record, zone or title…"
								aria-label="Search DNS findings"
								className={SEARCH_INPUT}
							/>
						</div>
						<button type="button" onClick={exportCsv} disabled={!filteredDnsRows.length} className={BTN_SECONDARY}>
							Export CSV
						</button>
					</div>
				</div>

				{dnsRows.length === 0 ? (
					<EmptyNote title={cleanDnsTitle} loading={loading} />
				) : filteredDnsRows.length === 0 ? (
					<EmptyNote title="No matching findings" loading={loading} />
				) : (
					<div className="mt-3 overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
								<tr>
									<th className="py-1.5 pr-3 font-medium">Severity</th>
									<th className="py-1.5 pr-3 font-medium">Zone</th>
									<th className="py-1.5 pr-3 font-medium">Record</th>
									<th className="py-1.5 pr-3 font-medium">Finding</th>
								</tr>
							</thead>
							<tbody>
								{filteredDnsRows.map((row, i) => (
									<tr key={`${row.zoneId}|${row.record.name}|${row.record.type}|${row.title}|${i}`} className="border-t border-zinc-100 align-top dark:border-zinc-800">
										<td className="py-1.5 pr-3">
											<span className={`${BADGE} uppercase ${DNS_SEVERITY_TONE[row.severity]}`}>{row.severity}</span>
										</td>
										<td className="py-1.5 pr-3">{row.zoneName}</td>
										<td className="py-1.5 pr-3 font-mono text-xs">
											{row.record.name} <span className={MUTED}>{row.record.type}</span>
											{row.record.content && <div className={`text-xs ${MUTED}`}>{row.record.content}</div>}
										</td>
										<td className="py-1.5 pr-3">
											<div className="font-medium">{row.title}</div>
											<div className={`text-xs ${MUTED}`}>{row.detail}</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{unknownRows.length > 0 && (
				<section className={CARD}>
					<h2 className={`mb-3 ${SECTION_TITLE}`}>Unable to check</h2>
					<p className={`mb-3 text-xs ${MUTED}`}>
						These records could not be resolved or matched against a source of truth — reported here rather than treated as
						clean.
					</p>
					<ul className="space-y-1.5">
						{unknownRows.map((row, i) => (
							<li key={`${row.zoneId}|${row.record.name}|${row.record.type}|${i}`} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-mono text-xs">
										{row.record.name} <span className={MUTED}>{row.record.type}</span>
									</span>
									<span className={`text-xs ${MUTED}`}>{row.zoneName}</span>
								</div>
								<p className={`mt-0.5 text-xs ${MUTED}`}>{row.reason}</p>
							</li>
						))}
					</ul>
				</section>
			)}
		</PageShell>
	);
}

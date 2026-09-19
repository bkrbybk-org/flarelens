import { useEffect, useMemo, useState } from "react";
import { PageShell } from "../../components/PageShell";
import type { LoadProgress } from "../../hooks/useEstimatedProgress";
import { EmptyState } from "../../components/EmptyState";
import { ALERT_ERROR } from "../../lib/ui";
import { AlertIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import { buildReportHtml, downloadHtml, type SourceCoverage } from "../../lib/report";
import {
	accessFindings, cacheFindings, countBySeverity, groupsFindings, sortFindings, wafFindings, type Finding, type FindingSource, type Severity,
} from "../../lib/findings";
import { botsFindings, dnsRecordsFindings, pqcFindings, tunnelsFindings, wafEvaluationFindings, zoneHealthFindings } from "../../lib/findings-sources";
import { useCacheSnapshot, useWafSnapshot } from "../../lib/sectionSnapshot";
import { aggregateRules } from "../../lib/waf/aggregate";
import { useFindingsSources } from "./useFindingsSources";
import type { CfApp, CfGroup, CfPolicy } from "../../types";
import type { Session } from "../../hooks/useSession";

interface FindingsPageProps {
	session: Session;
	apps: CfApp[];
	groups: CfGroup[];
	reusableMap: Record<string, CfPolicy>;
	loading: boolean;
	error: string | null;
	progress: LoadProgress;
	onNavigate: (href: string) => void;
	onAuthError: () => void;
}

const SEVERITY_BADGE_STYLES: Record<Severity, string> = {
	high: "border-red-300/50 bg-red-500/10 text-red-600 dark:border-red-500/30 dark:text-red-400",
	medium: "border-amber-300/50 bg-amber-500/10 text-amber-700 dark:border-amber-500/30 dark:text-amber-400",
	low: "border-sky-300/50 bg-sky-500/10 text-sky-700 dark:border-sky-500/30 dark:text-sky-400",
};

const SEVERITY_CARD_BORDER: Record<Severity, string> = {
	high: "border-red-300/50 dark:border-red-500/30",
	medium: "border-amber-300/50 dark:border-amber-500/30",
	low: "border-sky-300/50 dark:border-sky-500/30",
};

const SOURCE_LABELS: Record<FindingSource, string> = {
	access: "Access",
	groups: "Groups",
	waf: "WAF",
	cache: "Cache",
	tunnels: "Tunnels",
	"zone-health": "Zone Health",
	pqc: "PQC",
	dns: "DNS Records",
	bots: "Rate Limits & Bots",
};

function exportFindingsCsv(findings: Finding[]) {
	const csv = toCsv(findings, [
		{ header: "Severity", value: (f) => f.severity },
		{ header: "Source", value: (f) => SOURCE_LABELS[f.source] },
		{ header: "Title", value: (f) => f.title },
		{ header: "Detail", value: (f) => f.detail },
		{ header: "Link", value: (f) => f.href },
	]);
	downloadCsv(`flarelens-findings-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

export function FindingsPage({ session, apps, groups, reusableMap, loading, error, progress, onNavigate, onAuthError }: FindingsPageProps) {
	const { accountId, accountName } = session;
	// Scoped by account: a snapshot captured for a different customer must not
	// be reported here, nor counted as that section having been checked.
	const wafSnapshot = useWafSnapshot(accountId);
	const cacheSnapshot = useCacheSnapshot(accountId);

	// Tunnels, Zone Health, PQC, DNS Records and Rate Limits & Bots — fetched by this page itself,
	// concurrently, through the same edge-cached routes their own pages use.
	const { load: loadSources, ...sources } = useFindingsSources(onAuthError);
	useEffect(() => {
		loadSources(session.token, accountId);
	}, [session.token, accountId, loadSources]);

	const [sourceFilter, setSourceFilter] = useState<FindingSource | "all">("all");

	const findings = useMemo(() => {
		const all: Finding[] = [
			...accessFindings(apps, reusableMap),
			...groupsFindings(groups, apps, reusableMap),
		];
		if (wafSnapshot) {
			const rows = aggregateRules(wafSnapshot.events, wafSnapshot.ruleMeta);
			all.push(...wafFindings(rows));
			all.push(...wafEvaluationFindings(wafSnapshot.ruleMeta, rows));
		}
		if (cacheSnapshot) {
			all.push(...cacheFindings(cacheSnapshot));
		}
		if (sources.tunnels.status === "ok") all.push(...tunnelsFindings(sources.tunnels.result));
		if (sources.zoneHealth.status === "ok") all.push(...zoneHealthFindings(sources.zoneHealth.result));
		if (sources.pqc.status === "ok") all.push(...pqcFindings(sources.pqc.result));
		if (sources.dns.status === "ok") all.push(...dnsRecordsFindings(sources.dns.result));
		if (sources.bots.status === "ok") all.push(...botsFindings(sources.bots.result));
		return sortFindings(all);
	}, [apps, groups, reusableMap, wafSnapshot, cacheSnapshot, sources]);

	const visibleFindings = useMemo(
		() => (sourceFilter === "all" ? findings : findings.filter((f) => f.source === sourceFilter)),
		[findings, sourceFilter],
	);

	const counts = useMemo(() => countBySeverity(visibleFindings), [visibleFindings]);

	// One row per source, for the "what was checked" panel and for the executive report's
	// coverage table. Access and Groups always ride on the same loader as the rest of the app;
	// WAF and Cache stay "not opened" until their own pages have been visited this session.
	const coverage: SourceCoverage[] = useMemo(() => {
		const countFor = (source: FindingSource) => findings.filter((f) => f.source === source).length;
		const rows: SourceCoverage[] = [
			{ source: "access", label: SOURCE_LABELS.access, status: "checked", count: countFor("access") },
			{ source: "groups", label: SOURCE_LABELS.groups, status: "checked", count: countFor("groups") },
			wafSnapshot
				? { source: "waf", label: SOURCE_LABELS.waf, status: "checked", count: countFor("waf") }
				: { source: "waf", label: SOURCE_LABELS.waf, status: "not-opened", reason: "Open WAF Analytics to include its findings." },
			cacheSnapshot
				? { source: "cache", label: SOURCE_LABELS.cache, status: "checked", count: countFor("cache") }
				: { source: "cache", label: SOURCE_LABELS.cache, status: "not-opened", reason: "Open Cache Rules and analyze a zone to include its findings." },
		];
		const dynamic: { source: FindingSource; state: { status: "loading" | "ok" | "error"; reason?: string } }[] = [
			{ source: "tunnels", state: sources.tunnels },
			{ source: "zone-health", state: sources.zoneHealth },
			{ source: "pqc", state: sources.pqc },
			{ source: "dns", state: sources.dns },
			{ source: "bots", state: sources.bots },
		];
		for (const { source, state } of dynamic) {
			if (state.status === "ok") rows.push({ source, label: SOURCE_LABELS[source], status: "checked", count: countFor(source) });
			else if (state.status === "loading") rows.push({ source, label: SOURCE_LABELS[source], status: "loading" });
			else rows.push({ source, label: SOURCE_LABELS[source], status: "not-checked", reason: state.reason });
		}
		return rows;
	}, [findings, wafSnapshot, cacheSnapshot, sources]);

	function exportReport() {
		const html = buildReportHtml({
			accountName,
			generatedAt: new Date().toISOString(),
			findings,
			coverage,
		});
		downloadHtml(`flarelens-report-${new Date().toISOString().slice(0, 10)}.html`, html);
	}

	const anyLoading = Object.values(sources).some((s) => s.status === "loading");

	return (
		<PageShell id="findings-print-root" progress={progress}>

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{/* Toolbar */}
			<div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="font-medium">
						{visibleFindings.length === 0
							? "No findings"
							: `${counts.high} high, ${counts.medium} medium, ${counts.low} low`}
					</span>
					<select
						value={sourceFilter}
						onChange={(e) => setSourceFilter(e.target.value as FindingSource | "all")}
						className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						aria-label="Filter findings by source"
					>
						<option value="all">All sources</option>
						{coverage.map((c) => (
							<option key={c.source} value={c.source}>{c.label}</option>
						))}
					</select>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={exportReport}
						className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
					>
						Report
					</button>
					<button
						type="button"
						onClick={() => exportFindingsCsv(visibleFindings)}
						disabled={visibleFindings.length === 0}
						className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
					>
						Export CSV
					</button>
					<button
						type="button"
						onClick={() => window.print()}
						className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
					>
						Print / Save as PDF
					</button>
				</div>
			</div>

			{/* Per-source status: which sections were checked, and why one was not */}
			<div className="grid grid-cols-1 gap-1.5 text-xs text-zinc-500 sm:grid-cols-2 dark:text-zinc-400 print:hidden">
				{coverage.map((c) => (
					<p key={c.source}>
						<span className="font-medium text-zinc-700 dark:text-zinc-300">{c.label}</span>
						{" — "}
						{c.status === "checked" && `checked (${c.count} finding${c.count === 1 ? "" : "s"}).`}
						{c.status === "loading" && "loading…"}
						{c.status === "not-checked" && (
							<>
								<span className="text-amber-600 dark:text-amber-400">not checked</span> — {c.reason}
							</>
						)}
						{c.status === "not-opened" && (
							<>
								not opened —{" "}
								<button type="button" onClick={() => onNavigate(`#/${c.source}`)} className="underline hover:text-cf">
									open that section
								</button>
								{c.reason ? ` (${c.reason})` : ""}
							</>
						)}
					</p>
				))}
			</div>

			{!loading && !anyLoading && visibleFindings.length === 0 ? (
				<EmptyState
					icon={AlertIcon}
					iconClass="text-emerald-500"
					title="No findings across the checked sources"
					hint="Every source that was checked came back clean. Sources marked not checked or not opened above are not included."
				/>
			) : (
				<div className="space-y-3">
					{visibleFindings.map((f) => (
						<div
							key={f.id}
							className={`break-inside-avoid rounded-xl border bg-white p-4 dark:bg-zinc-900 ${SEVERITY_CARD_BORDER[f.severity]}`}
						>
							<div className="mb-1 flex flex-wrap items-center gap-2">
								<span className={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${SEVERITY_BADGE_STYLES[f.severity]}`}>
									{f.severity}
								</span>
								<span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
									{SOURCE_LABELS[f.source]}
								</span>
								<h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{f.title}</h3>
							</div>
							<p className="text-sm text-zinc-600 dark:text-zinc-300">{f.detail}</p>
							<button
								type="button"
								onClick={() => onNavigate(f.href)}
								className="mt-2 text-xs font-medium text-cf hover:underline print:hidden"
							>
								View in {SOURCE_LABELS[f.source]} →
							</button>
						</div>
					))}
				</div>
			)}
		</PageShell>
	);
}

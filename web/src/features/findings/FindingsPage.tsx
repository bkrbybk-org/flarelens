import { useMemo } from "react";
import { PageShell } from "../../components/PageShell";
import type { LoadProgress } from "../../hooks/useEstimatedProgress";
import { EmptyState } from "../../components/EmptyState";
import { ALERT_ERROR } from "../../lib/ui";
import { AlertIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import {
	accessFindings, cacheFindings, countBySeverity, groupsFindings, sortFindings, wafFindings, type Finding, type Severity,
} from "../../lib/findings";
import { useCacheSnapshot, useWafSnapshot } from "../../lib/sectionSnapshot";
import { aggregateRules } from "../../lib/waf/aggregate";
import type { CfApp, CfGroup, CfPolicy } from "../../types";

interface FindingsPageProps {
	accountId: string;
	apps: CfApp[];
	groups: CfGroup[];
	reusableMap: Record<string, CfPolicy>;
	loading: boolean;
	error: string | null;
	progress: LoadProgress;
	onNavigate: (href: string) => void;
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

const SOURCE_LABELS: Record<Finding["source"], string> = {
	access: "Access",
	groups: "Groups",
	waf: "WAF",
	cache: "Cache",
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

export function FindingsPage({ accountId, apps, groups, reusableMap, loading, error, progress, onNavigate }: FindingsPageProps) {
	// Scoped by account: a snapshot captured for a different customer must not
	// be reported here, nor counted as that section having been checked.
	const wafSnapshot = useWafSnapshot(accountId);
	const cacheSnapshot = useCacheSnapshot(accountId);

	const findings = useMemo(() => {
		const all: Finding[] = [
			...accessFindings(apps, reusableMap),
			...groupsFindings(groups, apps, reusableMap),
		];
		if (wafSnapshot) {
			all.push(...wafFindings(aggregateRules(wafSnapshot.events, wafSnapshot.ruleMeta)));
		}
		if (cacheSnapshot) {
			all.push(...cacheFindings(cacheSnapshot));
		}
		return sortFindings(all);
	}, [apps, groups, reusableMap, wafSnapshot, cacheSnapshot]);

	const counts = useMemo(() => countBySeverity(findings), [findings]);

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
						{findings.length === 0
							? "No findings"
							: `${counts.high} high, ${counts.medium} medium, ${counts.low} low`}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => exportFindingsCsv(findings)}
						disabled={findings.length === 0}
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

			{/* Per-source status: which sections were checked */}
			<div className="grid grid-cols-1 gap-2 text-xs text-zinc-500 sm:grid-cols-2 dark:text-zinc-400 print:hidden">
				<p>Access Applications and Access Groups — checked.</p>
				<p>
					{wafSnapshot
						? "WAF Analytics — checked."
						: (
							<>
								WAF Analytics not loaded —{" "}
								<button type="button" onClick={() => onNavigate("#/waf")} className="underline hover:text-cf">
									open that section
								</button>{" "}
								to include its findings.
							</>
						)}
				</p>
				<p>
					{cacheSnapshot
						? `Cache Rules (${cacheSnapshot.zoneName}) — checked.`
						: (
							<>
								Cache Rules not loaded —{" "}
								<button type="button" onClick={() => onNavigate("#/cache")} className="underline hover:text-cf">
									open that section
								</button>{" "}
								and analyze a zone to include its findings.
							</>
						)}
				</p>
			</div>

			{!loading && findings.length === 0 ? (
				<EmptyState
					icon={AlertIcon}
					iconClass="text-emerald-500"
					title="No findings across the checked sources"
					hint={<>
						Access, Groups{wafSnapshot ? ", WAF" : ""}{cacheSnapshot ? ", Cache" : ""} came back clean. Sources not yet
						opened are not included — see the status lines above.
					</>}
				/>
			) : (
				<div className="space-y-3">
					{findings.map((f) => (
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

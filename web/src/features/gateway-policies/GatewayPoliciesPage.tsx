import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { useHashSyncedState } from "../../hooks/useHashParams";
import { EmptyNote, EmptyState } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { Tabs, type TabSpec } from "../../components/Tabs";
import { ALERT_ERROR, BADGE, BADGE_NEUTRAL, BTN_SECONDARY, CARD, MUTED, SEARCH_INPUT, SECTION_TITLE } from "../../lib/ui";
import { FilterIcon, SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import { cacheAgeLabel } from "../../lib/edge-cache-caption";
import type { Session } from "../../hooks/useSession";
import { useGatewayPoliciesReport } from "./useGatewayPoliciesReport";
import type { GwFilterType, GwFinding, GwOrderedRule, GwSeverity, GwStageView } from "./types";

const TYPE_LABEL: Record<GwFilterType, string> = {
	dns_resolver: "DNS resolver",
	dns: "DNS",
	l4: "Network (L4)",
	http: "HTTP",
};

const SEVERITY_ORDER: Record<GwSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_TONE: Record<GwSeverity, string> = {
	high: "bg-red-500/10 text-red-600 dark:text-red-400",
	medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
	info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

function ActionChip({ action, terminating }: { action: string; terminating: boolean }) {
	const tone = terminating ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-sky-500/10 text-sky-700 dark:text-sky-300";
	return <span className={`${BADGE} ${tone}`}>{action || "—"}</span>;
}

function ExprLine({ label, value }: { label: string; value: string }) {
	const [open, setOpen] = useState(false);
	if (!value) return null;
	const long = value.length > 60;
	return (
		<div className="flex min-w-0 items-start gap-1.5 text-xs">
			<span className={`shrink-0 font-medium ${MUTED}`}>{label}</span>
			<code
				className={`min-w-0 flex-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-950 ${open || !long ? "" : "truncate"}`}
				title={long ? undefined : value}
			>
				{value}
			</code>
			{long && (
				<button type="button" className={`shrink-0 underline ${MUTED}`} onClick={() => setOpen((v) => !v)}>
					{open ? "less" : "more"}
				</button>
			)}
		</div>
	);
}

function RuleRow({ item }: { item: GwOrderedRule }) {
	const { rule } = item;
	return (
		<li className={`rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 ${rule.enabled ? "" : "opacity-60"}`}>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`w-8 shrink-0 text-right font-mono text-xs tabular-nums ${MUTED}`}>#{item.position}</span>
				<span className="min-w-0 flex-1 truncate font-medium">{rule.name}</span>
				<ActionChip action={rule.action} terminating={item.terminating} />
				{!rule.enabled && <span className={BADGE_NEUTRAL}>Disabled</span>}
				{item.shadowedBy && (
					<span
						className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`}
						title={`Shadowed by "${item.shadowedBy.name}", an earlier rule that matches every request and terminates evaluation first.`}
					>
						Never runs
					</span>
				)}
			</div>
			{rule.description && <p className={`mt-1 text-xs ${MUTED}`}>{rule.description}</p>}
			<div className="mt-1.5 space-y-1">
				<ExprLine label="traffic" value={rule.traffic} />
				<ExprLine label="identity" value={rule.identity} />
				<ExprLine label="posture" value={rule.devicePosture} />
			</div>
		</li>
	);
}

function StageSection({ view }: { view: GwStageView }) {
	if (view.rules.length === 0) {
		return (
			<section aria-label={view.stage.label} className="rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
				<h3 className="text-sm font-semibold">{view.stage.label}</h3>
				<p className={`mt-1 text-xs ${MUTED}`}>{view.stage.detail} No rules of this type.</p>
			</section>
		);
	}
	return (
		<section aria-label={view.stage.label} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
			<h3 className="text-sm font-semibold">{view.stage.label}</h3>
			<p className={`mb-2 mt-1 text-xs ${MUTED}`}>{view.stage.detail}</p>
			<ul className="space-y-1.5">
				{view.rules.map((item) => (
					<RuleRow key={item.rule.id} item={item} />
				))}
			</ul>
		</section>
	);
}

const TYPE_TABS: TabSpec<GwFilterType | "all">[] = [
	{ id: "all", label: "All" },
	{ id: "dns_resolver", label: "DNS resolver" },
	{ id: "dns", label: "DNS" },
	{ id: "l4", label: "Network" },
	{ id: "http", label: "HTTP" },
];

export function GatewayPoliciesPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [typeFilter, setTypeFilter] = useState<GwFilterType | "all">("all");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, cachedAt, progress, load } = useGatewayPoliciesReport(onAuthError);

	useHashSyncedState("q", search, setSearch, "gateway-policies");
	useHashSyncedState("gp_type", typeFilter === "all" ? "" : typeFilter, (v) => setTypeFilter((v || "all") as GwFilterType | "all"), "gateway-policies");

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

	const matchesSearch = useCallback(
		(name: string, description: string) => {
			const q = search.trim().toLowerCase();
			if (!q) return true;
			return `${name} ${description}`.toLowerCase().includes(q);
		},
		[search],
	);

	const visibleStages = useMemo(() => {
		const stages = result?.stages ?? [];
		return stages
			.filter((s) => typeFilter === "all" || s.stage.id === typeFilter)
			.map((s) => ({ ...s, rules: s.rules.filter((r) => matchesSearch(r.rule.name, r.rule.description)) }));
	}, [result, typeFilter, matchesSearch]);

	const findingRows = useMemo<GwFinding[]>(() => {
		const findings = (result?.findings ?? []).filter((f) => typeFilter === "all" || f.filterType === typeFilter);
		return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	}, [result, typeFilter]);

	const totals = result?.totals ?? { rules: 0, enabled: 0, disabled: 0, byType: { dns: 0, http: 0, l4: 0, dns_resolver: 0 } };

	function exportCsv() {
		const rows = visibleStages.flatMap((s) => s.rules.map((r) => ({ stage: s.stage.label, ...r })));
		const csv = toCsv(rows, [
			{ header: "type", value: (r) => r.stage },
			{ header: "position", value: (r) => r.position },
			{ header: "precedence", value: (r) => r.rule.precedence },
			{ header: "name", value: (r) => r.rule.name },
			{ header: "action", value: (r) => r.rule.action },
			{ header: "enabled", value: (r) => r.rule.enabled },
			{ header: "terminating", value: (r) => r.terminating },
			{ header: "never_runs_reason", value: (r) => (r.shadowedBy ? `shadowed by ${r.shadowedBy.name}` : "") },
			{ header: "traffic", value: (r) => r.rule.traffic },
			{ header: "identity", value: (r) => r.rule.identity },
			{ header: "device_posture", value: (r) => r.rule.devicePosture },
		]);
		downloadCsv(`gateway-policies-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<PageShell progress={progress}>
			{cachedAt && <p className={`text-xs ${MUTED}`}>{cacheAgeLabel(cachedAt)}</p>}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			<p className={`text-xs ${MUTED}`}>
				Gateway rules in the order Cloudflare enforces them —{" "}
				<a
					href="https://developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/"
					target="_blank"
					rel="noreferrer"
					className="underline"
				>
					order of enforcement
				</a>
				: DNS resolver, then DNS, then Network, then HTTP; ascending precedence within each. Cloudflare orders a DNS policy's
				pre- vs post-resolution selectors ahead of precedence — this view cannot tell the two apart from the rule fields alone,
				so its DNS list is precedence-only. "Never runs" is only claimed for a rule sitting behind an earlier, enabled,
				terminating rule of the same type whose traffic, identity and device posture conditions are all empty or a literal
				match-everything — any other overlap between two rules is not claimed here.
			</p>

			<StatGrid cols={6}>
				<StatCard label="Rules" value={totals.rules} />
				<StatCard label="Enabled" value={totals.enabled} />
				<StatCard label="Disabled" value={totals.disabled} tone={totals.disabled ? "text-amber-700 dark:text-amber-400" : undefined} />
				<StatCard label="DNS resolver" value={totals.byType.dns_resolver} />
				<StatCard label="DNS" value={totals.byType.dns} />
				<StatCard label="Network / HTTP" value={totals.byType.l4 + totals.byType.http} hint={`${totals.byType.l4} network, ${totals.byType.http} HTTP`} />
			</StatGrid>

			<section className={CARD}>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className={SECTION_TITLE}>Rules in enforcement order</h2>
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-0 flex-1 basis-64">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
							<input
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search rule name or description…"
								aria-label="Search Gateway rules"
								className={SEARCH_INPUT}
							/>
						</div>
						<button type="button" onClick={exportCsv} disabled={!visibleStages.some((s) => s.rules.length)} className={BTN_SECONDARY}>
							Export CSV
						</button>
					</div>
				</div>
				<div className="mt-3">
					<Tabs tabs={TYPE_TABS} active={typeFilter} onChange={setTypeFilter} label="Filter by policy type" idPrefix="gp-type" />
				</div>

				{totals.rules === 0 ? (
					<EmptyNote title="No Gateway rules yet" loading={loading} />
				) : (
					<div className="mt-3 space-y-3">
						{visibleStages.map((s) => (
							<StageSection key={s.stage.id} view={s} />
						))}
					</div>
				)}
			</section>

			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Findings</h2>
				{findingRows.length === 0 ? (
					<EmptyState icon={FilterIcon} title="No findings" hint="Nothing flagged for the current type filter." />
				) : (
					<ul className="space-y-1.5">
						{findingRows.map((f, i) => (
							<li key={`${f.ruleId ?? f.filterType}|${f.title}|${i}`} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
								<div className="flex flex-wrap items-center gap-2">
									<span className={`${BADGE} uppercase ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span>
									<span className="font-medium">{f.title}</span>
									{f.filterType && <span className={`text-xs ${MUTED}`}>{TYPE_LABEL[f.filterType]}</span>}
									{f.ruleName && <span className={`text-xs ${MUTED}`}>· {f.ruleName}</span>}
								</div>
								<p className={`mt-0.5 text-xs ${MUTED}`}>{f.detail}</p>
							</li>
						))}
					</ul>
				)}
			</section>
		</PageShell>
	);
}

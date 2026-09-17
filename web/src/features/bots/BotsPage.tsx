import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { Tabs, TabPanel, type TabSpec } from "../../components/Tabs";
import { ALERT_WARN, BADGE, BADGE_NEUTRAL, CARD, MUTED, SECTION_TITLE } from "../../lib/ui";
import { cacheAgeLabel } from "../../lib/edge-cache-caption";
import type { Session } from "../../hooks/useSession";
import { useBotsReport } from "./useBotsReport";
import type { BotManagementZone, Finding, FindingSeverity, RateLimitRule } from "./types";

type TabId = "rate-limits" | "bot-settings" | "findings";

const TABS: TabSpec<TabId>[] = [
	{ id: "rate-limits", label: "Rate limits" },
	{ id: "bot-settings", label: "Bot settings" },
	{ id: "findings", label: "Findings" },
];

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const SEVERITY_TONE: Record<FindingSeverity, string> = {
	high: "bg-red-500/10 text-red-600 dark:text-red-400",
	medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
	info: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

const PLAN_TIER_LABEL: Record<string, string> = {
	enterprise: "Enterprise Bot Management",
	super_bot_fight_mode: "Super Bot Fight Mode",
	bot_fight_mode: "Bot Fight Mode",
	unknown: "Unknown",
};

/** A boolean/string setting rendered as a badge, with a visibly distinct pill for "unknown". */
function SettingBadge({ label, value }: { label: string; value: unknown }) {
	let tone = BADGE_NEUTRAL;
	let text: string;
	if (value === undefined) {
		text = "not reported";
		tone = `${BADGE} bg-zinc-500/10 text-zinc-400 italic dark:text-zinc-500`;
	} else if (typeof value === "boolean") {
		text = value ? "on" : "off";
		tone = value ? `${BADGE} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` : `${BADGE} bg-zinc-500/15 text-zinc-600 dark:text-zinc-400`;
	} else {
		text = String(value);
	}
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className={`text-xs ${MUTED}`}>{label}</span>
			<span className={tone}>{text}</span>
		</span>
	);
}

const BOT_SETTING_KEYS = [
	"fight_mode",
	"sbfm_definitely_automated",
	"sbfm_likely_automated",
	"sbfm_verified_bots",
	"sbfm_static_resource_protection",
	"optimize_wordpress",
	"enable_js",
	"ai_bots_protection",
	"crawler_protection",
	"using_latest_model",
	"suppress_session_score",
	"auto_update_model",
];

function BotSettingsRow({ zone }: { zone: BotManagementZone }) {
	if (zone.status !== "ok") {
		return (
			<tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
				<td className="py-1.5 pr-3 font-medium">{zone.zoneName}</td>
				<td colSpan={2} className="py-1.5 pr-3">
					<span className={ALERT_WARN}>Not checked — {zone.reason}</span>
				</td>
			</tr>
		);
	}
	// Any key the response carried, beyond the ones this page names explicitly — passed through
	// rather than dropped, in case Cloudflare adds a field this page does not yet know about.
	const extraKeys = Object.keys(zone.settings).filter((k) => !BOT_SETTING_KEYS.includes(k));
	return (
		<tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
			<td className="py-1.5 pr-3 font-medium">{zone.zoneName}</td>
			<td className="py-1.5 pr-3">
				<span className={BADGE_NEUTRAL}>{PLAN_TIER_LABEL[zone.planTier]}</span>
			</td>
			<td className="py-1.5 pr-3">
				<div className="flex flex-wrap gap-x-4 gap-y-1.5">
					{BOT_SETTING_KEYS.filter((k) => k in zone.settings).map((k) => (
						<SettingBadge key={k} label={k} value={zone.settings[k]} />
					))}
					{extraKeys.map((k) => (
						<SettingBadge key={k} label={k} value={zone.settings[k]} />
					))}
				</div>
			</td>
		</tr>
	);
}

function ExpressionCell({ expression }: { expression: string }) {
	const [open, setOpen] = useState(false);
	if (!expression) return <span className={MUTED}>—</span>;
	return (
		<button type="button" onClick={() => setOpen((o) => !o)} className="text-left">
			<span className={`font-mono text-xs ${open ? "" : "line-clamp-1"}`}>{expression}</span>
			{!open && expression.length > 40 && <span className={`ml-1 text-xs ${MUTED}`}>(expand)</span>}
		</button>
	);
}

function thresholdLabel(rule: RateLimitRule): string {
	const rl = rule.ratelimit;
	if (!rl || typeof rl.requestsPerPeriod !== "number" || typeof rl.period !== "number") return "—";
	return `${rl.requestsPerPeriod} req / ${rl.period}s`;
}

interface RateLimitRow {
	scope: "zone" | "account";
	zoneName: string;
	rule: RateLimitRule;
}

export function BotsPage({ session, zoneId, onAuthError }: { session: Session; zoneId: string; onAuthError: () => void }) {
	const [tab, setTab] = useState<TabId>("rate-limits");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, cachedAt, progress, load } = useBotsReport(onAuthError);
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
		load(session.token, session.accountId, zoneId, fresh);
	}, [session.token, session.accountId, zoneId, reloadKey, load]);

	const rateLimitRows = useMemo<RateLimitRow[]>(() => {
		const rows: RateLimitRow[] = [];
		for (const scope of result?.rateLimit ?? []) {
			if (scope.status !== "ok") continue;
			for (const rule of scope.rules) {
				rows.push({ scope: scope.scope, zoneName: scope.scope === "account" ? "Account (all zones)" : scope.zoneName || "", rule });
			}
		}
		return rows;
	}, [result]);

	const unknownRateLimitScopes = useMemo(() => (result?.rateLimit ?? []).filter((s) => s.status !== "ok"), [result]);

	const findings = useMemo<Finding[]>(() => {
		const list = result?.findings ?? [];
		return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
	}, [result]);

	const totals = result?.totals ?? {
		zonesChecked: 0,
		rateLimitRules: 0,
		zonesWithNoRateLimitRules: 0,
		botProtectionOn: 0,
		botProtectionOff: 0,
		botProtectionUnknown: 0,
	};

	return (
		<PageShell progress={progress}>
			{cachedAt && <p className={`text-xs ${MUTED}`}>{cacheAgeLabel(cachedAt)}</p>}

			{error && (
				<div role="alert" className={ALERT_WARN}>
					{error}
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard label="Zones checked" value={totals.zonesChecked} />
				<StatCard label="Rate-limit rules" value={totals.rateLimitRules} />
				<StatCard
					label="Zones with none"
					value={totals.zonesWithNoRateLimitRules}
					tone={totals.zonesWithNoRateLimitRules ? "text-amber-700 dark:text-amber-400" : undefined}
				/>
				<StatCard
					label="Bot protection"
					value={`${totals.botProtectionOn} on`}
					hint={`${totals.botProtectionOff} off · ${totals.botProtectionUnknown} unknown`}
					tone={totals.botProtectionOff ? "text-red-600 dark:text-red-400" : undefined}
				/>
			</StatGrid>

			<Tabs tabs={TABS} active={tab} onChange={setTab} label="Rate Limits & Bots views" idPrefix="bots" />

			{tab === "rate-limits" && (
				<TabPanel id="rate-limits" idPrefix="bots">
					<section className={CARD}>
						<h2 className={`mb-3 ${SECTION_TITLE}`}>Rate-limit rules</h2>
						{unknownRateLimitScopes.length > 0 && (
							<div className="mb-3 space-y-2">
								{unknownRateLimitScopes.map((s) => (
									<div key={`${s.scope}-${s.zoneId ?? "account"}`} className={ALERT_WARN}>
										<span className="font-medium">
											{s.scope === "account" ? "Account" : s.zoneName}: not checked.
										</span>{" "}
										{s.reason}
									</div>
								))}
							</div>
						)}
						{rateLimitRows.length === 0 ? (
							<EmptyNote title="No rate-limit rules found" loading={loading} />
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
										<tr>
											<th className="py-1.5 pr-3 font-medium">Scope</th>
											<th className="py-1.5 pr-3 font-medium">Zone</th>
											<th className="py-1.5 pr-3 font-medium">Rule</th>
											<th className="py-1.5 pr-3 font-medium">Action</th>
											<th className="py-1.5 pr-3 font-medium">Characteristics</th>
											<th className="py-1.5 pr-3 font-medium">Threshold</th>
											<th className="py-1.5 pr-3 font-medium">Timeout</th>
											<th className="py-1.5 pr-3 font-medium">Enabled</th>
											<th className="py-1.5 pr-3 font-medium">Expression</th>
										</tr>
									</thead>
									<tbody>
										{rateLimitRows.map((row, i) => (
											<tr key={`${row.scope}-${row.zoneName}-${row.rule.ruleId}-${i}`} className="border-t border-zinc-100 align-top dark:border-zinc-800">
												<td className="py-1.5 pr-3">
													<span className={BADGE_NEUTRAL}>{row.scope}</span>
												</td>
												<td className="py-1.5 pr-3">{row.zoneName}</td>
												<td className="py-1.5 pr-3">{row.rule.description || row.rule.ruleId || "(unnamed)"}</td>
												<td className="py-1.5 pr-3">{row.rule.action || "—"}</td>
												<td className="py-1.5 pr-3 font-mono text-xs">{row.rule.ratelimit?.characteristics?.join(", ") || "—"}</td>
												<td className="py-1.5 pr-3 tabular-nums">{thresholdLabel(row.rule)}</td>
												<td className="py-1.5 pr-3 tabular-nums">
													{typeof row.rule.ratelimit?.mitigationTimeout === "number" ? `${row.rule.ratelimit.mitigationTimeout}s` : "—"}
												</td>
												<td className="py-1.5 pr-3">
													<span className={row.rule.enabled ? `${BADGE} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` : BADGE_NEUTRAL}>
														{row.rule.enabled ? "enabled" : "disabled"}
													</span>
												</td>
												<td className="py-1.5 pr-3 max-w-xs">
													<ExpressionCell expression={row.rule.expression} />
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

			{tab === "bot-settings" && (
				<TabPanel id="bot-settings" idPrefix="bots">
					<section className={CARD}>
						<h2 className={`mb-3 ${SECTION_TITLE}`}>Bot management settings</h2>
						{(result?.botManagement ?? []).length === 0 ? (
							<EmptyNote title="No zones checked" loading={loading} />
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
										<tr>
											<th className="py-1.5 pr-3 font-medium">Zone</th>
											<th className="py-1.5 pr-3 font-medium">Plan tier</th>
											<th className="py-1.5 pr-3 font-medium">Settings</th>
										</tr>
									</thead>
									<tbody>
										{(result?.botManagement ?? []).map((zone) => (
											<BotSettingsRow key={zone.zoneId} zone={zone} />
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>
				</TabPanel>
			)}

			{tab === "findings" && (
				<TabPanel id="findings" idPrefix="bots">
					<section className={CARD}>
						<h2 className={`mb-3 ${SECTION_TITLE}`}>Findings</h2>
						{findings.length === 0 ? (
							<EmptyNote title="No findings" loading={loading} />
						) : (
							<ul className="space-y-1.5">
								{findings.map((f, i) => (
									<li key={`${f.zoneId ?? "account"}-${f.title}-${i}`} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
										<div className="flex flex-wrap items-center gap-2">
											<span className={`${BADGE} uppercase ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span>
											<span className="font-medium">{f.title}</span>
											{f.zoneName && <span className={`text-xs ${MUTED}`}>{f.zoneName}</span>}
										</div>
										<p className={`mt-0.5 text-xs ${MUTED}`}>{f.detail}</p>
									</li>
								))}
							</ul>
						)}
					</section>
				</TabPanel>
			)}
		</PageShell>
	);
}

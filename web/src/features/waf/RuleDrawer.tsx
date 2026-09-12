import { useEffect, useMemo, useRef } from "react";
import { ALERT_WARN, BADGE_NEUTRAL } from "../../lib/ui";
import { XIcon } from "../../components/Icons";
import { actionDrift, ruleEventDetail, topEntries } from "../../lib/waf/aggregate";
import { relativeTime, titleCase } from "../../lib/waf/format";
import type { FirewallEvent, RuleMetaMap } from "../../lib/waf/types";
import { ActionBadges, RuleLevelBadge, RuleTypeBadge, Sparkline } from "./bars";

export interface DrawerRule {
	id: string;
	name: string;
	configuredAction?: string;
	lastSeen?: string;
}

interface RuleDrawerProps {
	rule: DrawerRule | null;
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
	window: { since: number; until: number } | null;
	onClose: () => void;
}

function TopList({ title, entries }: { title: string; entries: [string, number][] }) {
	if (!entries.length) return null;
	return (
		<div>
			<h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h4>
			<ul className="space-y-1 text-sm">
				{entries.map(([key, count]) => (
					<li key={key} className="flex items-center justify-between gap-3">
						<span className="min-w-0 truncate" title={key}>{key}</span>
						<span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{count.toLocaleString()}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function RuleDrawer({ rule, events, ruleMeta, window: win, onClose }: RuleDrawerProps) {
	const closeBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!rule) return;
		closeBtnRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [rule, onClose]);

	const detail = useMemo(() => (rule ? ruleEventDetail(events, rule.id) : null), [events, rule]);

	if (!rule || !detail) return null;

	const meta = ruleMeta[rule.id];
	const configured = rule.configuredAction || meta?.action || "";
	const drift = actionDrift({ configuredAction: configured, actions: detail.actions });

	return (
		<div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Details for rule ${rule.name}`}>
			<button type="button" aria-label="Close details" className="absolute inset-0 bg-black/50" onClick={onClose} />
			<div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[28rem] md:rounded-none dark:bg-zinc-900">
				<div className="sticky top-0 flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
					<div className="min-w-0">
						<h2 className="truncate text-base font-semibold">{rule.name}</h2>
						<p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{meta?.ruleset || rule.id}</p>
					</div>
					<button
						ref={closeBtnRef}
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
					>
						<XIcon size={18} />
					</button>
				</div>

				<div className="space-y-5 px-5 py-5">
					<div className="flex flex-wrap items-center gap-2">
						{meta && <RuleTypeBadge type={meta.type} />}
						{meta && <RuleLevelBadge level={meta.level} />}
						{meta?.enabled === false && (
							<span className={BADGE_NEUTRAL}>Disabled</span>
						)}
						{configured && (
							<span className="text-xs text-zinc-500 dark:text-zinc-400">Configured: {titleCase(configured)}</span>
						)}
					</div>

					{meta?.expression && (
						<code className="block max-h-28 overflow-auto rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs break-all dark:bg-zinc-950">
							{meta.expression}
						</code>
					)}

					{drift && (
						<div className={`${ALERT_WARN} !px-3 !py-2 text-xs font-medium`}>
							Action drift: configured {titleCase(drift.configured)}, observed {titleCase(drift.observed)}
						</div>
					)}

					<div className="flex items-center justify-between gap-3">
						<div>
							<div className="text-2xl font-semibold tabular-nums">{detail.total.toLocaleString()}</div>
							<div className="text-xs text-zinc-500 dark:text-zinc-400">
								events in window{rule.lastSeen ? ` · last ${relativeTime(rule.lastSeen)}` : ""}
							</div>
						</div>
						{win && detail.times.length > 0 && <Sparkline times={detail.times} since={win.since} until={win.until} />}
					</div>

					{detail.total > 0 && (
						<div className="flex flex-wrap gap-1.5">
							<ActionBadges actions={detail.actions} />
						</div>
					)}

					{detail.total === 0 ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">No events for this rule in the selected window.</p>
					) : (
						<div className="space-y-4">
							<TopList title="Top paths" entries={topEntries(detail.paths, 8)} />
							<TopList title="Top hosts" entries={topEntries(detail.hosts, 5)} />
							<TopList title="Top countries" entries={topEntries(detail.countries, 5)} />
							<TopList title="Top client IPs" entries={topEntries(detail.ips, 5)} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

import { useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ChevronDownIcon } from "../../components/Icons";
import { BADGE, BADGE_NEUTRAL, BTN_SECONDARY, FOCUS_RING, MUTED } from "../../lib/ui";
import { buildEvaluationOrder, type EvalItem, type EvalStage } from "../../lib/waf/evaluation";
import { titleCase } from "../../lib/waf/format";
import type { RuleMetaMap, RuleReviewRow } from "../../lib/waf/types";
import { RuleTypeBadge } from "./bars";

type SelectRule = (rule: { id: string; name: string; configuredAction?: string; lastSeen?: string }) => void;

/** Rules shown inside an executed ruleset before "Show all" — a managed ruleset has hundreds. */
const TARGET_PREVIEW = 10;

const TERMINATING = new Set(["block", "challenge", "managed_challenge", "js_challenge"]);

function ActionChip({ action }: { action: string }) {
	const tone = TERMINATING.has(action)
		? "bg-red-500/10 text-red-600 dark:text-red-400"
		: action === "log"
			? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
			: BADGE_NEUTRAL;
	return <span className={`${BADGE} ${tone}`}>{action ? titleCase(action) : "—"}</span>;
}

function RuleLine({ item, onSelect, nested = false }: { item: EvalItem; onSelect: SelectRule; nested?: boolean }) {
	const { row } = item;
	return (
		<button
			type="button"
			onClick={() => onSelect({ id: row.id, name: row.name, configuredAction: row.configuredAction, lastSeen: row.lastSeen })}
			className={`flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${FOCUS_RING} ${
				item.unreachable || !row.enabled ? "opacity-60" : ""
			}`}
		>
			<span className={`w-8 shrink-0 text-right font-mono text-xs tabular-nums ${MUTED}`}>{nested ? "" : "#"}{item.position}</span>
			<span className="min-w-0 flex-1 truncate">{row.name}</span>
			<ActionChip action={row.configuredAction} />
			{!row.enabled && <span className={BADGE_NEUTRAL}>Disabled</span>}
			{item.unreachable && (
				<span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`} title={item.unreachable}>
					Never runs
				</span>
			)}
			<span className={`w-16 shrink-0 text-right text-xs tabular-nums ${row.total ? "" : MUTED}`}>{row.total.toLocaleString()}</span>
		</button>
	);
}

function ExecuteItem({ item, visible, onSelect }: { item: EvalItem; visible: (row: RuleReviewRow) => boolean; onSelect: SelectRule }) {
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const target = item.target!;
	const inner = target.items.filter((i) => visible(i.row));
	const shown = showAll ? inner : inner.slice(0, TARGET_PREVIEW);
	const panelId = `waf-exec-${item.row.id}`;
	return (
		<li>
			<div className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${item.unreachable || !item.row.enabled ? "opacity-60" : ""}`}>
				<span className={`w-8 shrink-0 text-right font-mono text-xs tabular-nums ${MUTED}`}>#{item.position}</span>
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					aria-controls={panelId}
					className={`flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded text-left ${FOCUS_RING}`}
				>
					<ChevronDownIcon size={14} className={`shrink-0 ${MUTED} transition-transform ${open ? "" : "-rotate-90"}`} />
					<span className="font-medium">Runs {target.name}</span>
					{target.type && <RuleTypeBadge type={target.type} />}
					<span className={`text-xs ${MUTED}`}>
						{target.items.length.toLocaleString()} rules
						{item.row.expression.trim() !== "true" && item.row.expression ? " · only for matching requests" : ""}
					</span>
				</button>
				{!item.row.enabled && <span className={BADGE_NEUTRAL}>Disabled</span>}
				{item.unreachable && (
					<span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-400`} title={item.unreachable}>Never runs</span>
				)}
				{/* No event total here: events are counted per rule across every zone, so a sum on one
				    zone's deployment would credit it with other zones' traffic — even when disabled. */}
				<span className="w-16 shrink-0" />
			</div>
			{open && (
				<div id={panelId} className="ml-10 border-l-2 border-zinc-200 pl-2 dark:border-zinc-800">
					{item.row.expression && item.row.expression.trim() !== "true" && (
						<code className="mb-1 block truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-950" title={item.row.expression}>
							when {item.row.expression}
						</code>
					)}
					{inner.length === 0 ? (
						<p className={`px-2 py-1 text-xs ${MUTED}`}>No rule here matches the current filters.</p>
					) : (
						<ul>
							{shown.map((i) => (
								<li key={i.row.id}>
									<RuleLine item={i} onSelect={onSelect} nested />
								</li>
							))}
						</ul>
					)}
					{inner.length > TARGET_PREVIEW && (
						<button type="button" className={`${BTN_SECONDARY} my-1`} onClick={() => setShowAll((v) => !v)}>
							{showAll ? "Show fewer" : `Show all ${inner.length.toLocaleString()} rules`}
						</button>
					)}
				</div>
			)}
		</li>
	);
}

function Stage({ stage, visible, onSelect }: { stage: EvalStage; visible: (row: RuleReviewRow) => boolean; onSelect: SelectRule }) {
	const items = stage.items.filter((i) => visible(i.row) || i.target?.items.some((inner) => visible(inner.row)));
	if (items.length === 0) return null;
	return (
		<section aria-label={`${stage.phaseLabel} — ${stage.scope}`} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
			<h4 className="mb-1 flex items-center gap-2 px-2 text-sm font-semibold">
				{stage.scope}
				<span className={`text-xs font-normal ${MUTED}`}>{stage.level === "account" ? "account entrypoint — runs first" : "zone entrypoint"}</span>
			</h4>
			<ul>
				{items.map((item) =>
					item.target ? (
						<ExecuteItem key={item.row.id} item={item} visible={visible} onSelect={onSelect} />
					) : (
						<li key={item.row.id}>
							<RuleLine item={item} onSelect={onSelect} />
						</li>
					),
				)}
			</ul>
		</section>
	);
}

interface EvaluationOrderProps {
	ruleMeta: RuleMetaMap;
	rows: RuleReviewRow[];
	/** The active search and filters; ordering and numbering always come from the full set. */
	visible: (row: RuleReviewRow) => boolean;
	onSelect: SelectRule;
}

/** WAF rules in the order Cloudflare evaluates them. See lib/waf/evaluation.ts for the model. */
export function EvaluationOrder({ ruleMeta, rows, visible, onSelect }: EvaluationOrderProps) {
	const order = useMemo(() => buildEvaluationOrder(ruleMeta, rows), [ruleMeta, rows]);
	const phases = useMemo(() => {
		const byPhase = new Map<string, EvalStage[]>();
		for (const stage of order.stages) byPhase.set(stage.phaseLabel, [...(byPhase.get(stage.phaseLabel) ?? []), stage]);
		return [...byPhase];
	}, [order]);
	// Per scope, not one total: a zone that disables a deployment silences those rules in that
	// zone only, and a single account-wide number would read as if they never ran anywhere.
	const neverRuns = useMemo(() => {
		const byScope = new Map<string, number>();
		for (const stage of order.stages) {
			let n = 0;
			for (const item of stage.items) {
				if (item.unreachable) n++;
				for (const inner of item.target?.items ?? []) if (inner.unreachable) n++;
			}
			if (n) byScope.set(stage.scope, (byScope.get(stage.scope) ?? 0) + n);
		}
		return [...byScope].map(([scope, n]) => `${n.toLocaleString()} in ${scope === "Account" ? "every zone" : scope}`);
	}, [order]);

	// Nothing loaded yet: the page's own loader covers this, and "no rulesets" would be a claim.
	if (rows.length === 0) return null;
	if (order.stages.length === 0) {
		return <EmptyState title="No entrypoint rulesets found" hint="The token may not be able to read WAF rulesets for this scope." />;
	}

	return (
		<div className="space-y-4">
			<p className={`text-xs ${MUTED}`}>
				Top to bottom, the way Cloudflare evaluates a request: custom rules, then rate limiting, then managed rules; account
				before zone; each list in order. A terminating action (block, challenge) ends evaluation there — log, skip and
				execute do not. A rate-limiting rule acts only past its threshold. Managed rules show their default action; per-rule
				overrides on a deployment are not reflected. Event counts are per rule, across every zone. "Never runs" is only claimed behind a rule that matches every request.
				{neverRuns.length > 0 && (
					<strong className="text-amber-700 dark:text-amber-400"> Rules that never run: {neverRuns.join(", ")}.</strong>
				)}
			</p>
			{phases.map(([label, stages], i) => (
				<section key={label} aria-label={label}>
					<h3 className="mb-2 flex items-center gap-2 font-semibold">
						<span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 text-xs dark:bg-zinc-800">{i + 1}</span>
						{label}
						<span className={`ml-auto text-xs font-normal ${MUTED}`}>events</span>
					</h3>
					<div className="space-y-2">
						{stages.map((stage) => (
							<Stage key={stage.entrypointId} stage={stage} visible={visible} onSelect={onSelect} />
						))}
					</div>
				</section>
			))}
			{order.undeployed.length > 0 && (
				<section aria-label="Not deployed" className="rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
					<h3 className="mb-1 text-sm font-semibold">Not deployed — never evaluated</h3>
					<p className={`mb-2 text-xs ${MUTED}`}>
						These rulesets exist but no execute rule runs them, so none of their rules sees traffic.
					</p>
					<ul className="space-y-1 text-sm">
						{order.undeployed.map((r) => (
							<li key={r.id} className="flex flex-wrap items-center gap-2">
								<span>{r.name}</span>
								{r.type && <RuleTypeBadge type={r.type} />}
								<span className={`text-xs ${MUTED}`}>
									{/* A managed ruleset is offered to every zone; the metadata keeps one zone's copy. */}
									{r.type === "managed" ? "" : `${r.scope} · `}
									{r.ruleCount.toLocaleString()} rules
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

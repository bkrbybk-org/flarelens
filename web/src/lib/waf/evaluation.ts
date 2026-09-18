import type { RuleMetaEntry, RuleMetaMap, RuleReviewRow } from "./types";

/**
 * The order Cloudflare actually evaluates WAF rules in, rebuilt from ruleset metadata.
 *
 * Phases run in a fixed sequence — custom rules, then rate limiting, then managed rules — and
 * within a phase the account entrypoint runs before the zone's. Inside an entrypoint rules run
 * top-down; an `execute` rule runs another ruleset's rules, in their own order, at its own
 * position. A terminating action ends evaluation for that request: nothing after it, in this
 * phase or a later one, sees it.
 *
 * What this cannot see: managed-rule overrides (a deployment can re-enable or change the action
 * of individual managed rules; the defaults are shown), and overlap between expressions other
 * than a literal match-everything `true`. "Unreachable" is only claimed for that literal case.
 */

export const EVALUATION_PHASES = [
	{ phase: "http_request_firewall_custom", label: "Custom rules" },
	{ phase: "http_ratelimit", label: "Rate limiting rules" },
	{ phase: "http_request_firewall_managed", label: "Managed rules" },
] as const;

/** Actions that end evaluation for the request. `log`, `skip` and `execute` do not. */
const TERMINATING = new Set(["block", "challenge", "managed_challenge", "js_challenge"]);

export interface EvalItem {
	row: RuleReviewRow;
	/** 1-based position inside its ruleset, as the dashboard numbers rules. */
	position: number;
	/** Why this rule never runs, if it provably does not. */
	unreachable?: string;
	/** For an execute rule: the ruleset it runs, with that ruleset's rules in order. */
	target?: { id: string; name: string; type: string; items: EvalItem[] };
}

export interface EvalStage {
	phase: string;
	phaseLabel: string;
	level: "account" | "zone";
	/** "Account" or the zone name. */
	scope: string;
	entrypointId: string;
	items: EvalItem[];
}

export interface EvaluationOrder {
	stages: EvalStage[];
	/** Rulesets with rules that nothing deploys — they are never evaluated. */
	undeployed: { id: string; name: string; type: string; phase: string; scope: string; ruleCount: number }[];
}

function scopeLabel(entry: RuleMetaEntry): string {
	if (entry.level === "account" || entry.source === "account") return "Account";
	return entry.source.startsWith("zone:") ? entry.source.slice("zone:".length) : "Zone";
}

function byPosition(a: RuleReviewRow, b: RuleReviewRow): number {
	return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
}

/** A rule that stops every request reaching it: enabled, terminating, matching everything. */
function stopsEverything(row: RuleReviewRow, phase: string): boolean {
	// A rate-limiting rule acts only past its threshold, so even a match-all one lets
	// requests under the limit carry on.
	if (phase === "http_ratelimit") return false;
	return row.enabled && TERMINATING.has(row.configuredAction) && row.expression.trim() === "true";
}

export function buildEvaluationOrder(ruleMeta: RuleMetaMap, rows: RuleReviewRow[]): EvaluationOrder {
	const phaseIndex = new Map<string, number>(EVALUATION_PHASES.map((p, i) => [p.phase, i]));

	const rulesByRuleset = new Map<string, RuleReviewRow[]>();
	for (const row of rows) {
		if (!row.rulesetId || row.position === undefined) continue;
		const list = rulesByRuleset.get(row.rulesetId) ?? [];
		list.push(row);
		rulesByRuleset.set(row.rulesetId, list);
	}
	for (const list of rulesByRuleset.values()) list.sort(byPosition);

	// Ruleset entries, deduplicated (the map is keyed by id, but be explicit about it).
	const rulesets = new Map<string, RuleMetaEntry>();
	for (const [key, entry] of Object.entries(ruleMeta)) {
		if (entry?.isRuleset && !entry.placeholder) rulesets.set(entry.rulesetId || key, entry);
	}

	const toItem = (row: RuleReviewRow): EvalItem => ({ row, position: (row.position ?? 0) + 1 });

	const stages: EvalStage[] = [];
	for (const [id, entry] of rulesets) {
		if ((entry.kind !== "root" && entry.kind !== "zone") || !phaseIndex.has(entry.phase || "")) continue;
		const items = (rulesByRuleset.get(id) ?? []).map((row) => {
			const item = toItem(row);
			if (row.executes) {
				const target = ruleMeta[row.executes];
				item.target = {
					id: row.executes,
					name: target?.name || row.executes,
					type: target?.type || "",
					items: (rulesByRuleset.get(row.executes) ?? []).map(toItem),
				};
			}
			return item;
		});
		stages.push({
			phase: entry.phase as string,
			phaseLabel: EVALUATION_PHASES[phaseIndex.get(entry.phase as string) as number].label,
			level: entry.kind === "root" ? "account" : "zone",
			scope: scopeLabel(entry),
			entrypointId: id,
			items,
		});
	}

	stages.sort(
		(a, b) =>
			(phaseIndex.get(a.phase) as number) - (phaseIndex.get(b.phase) as number) ||
			(a.level === b.level ? 0 : a.level === "account" ? -1 : 1) ||
			a.scope.localeCompare(b.scope),
	);

	markUnreachable(stages);

	const deployed = new Set<string>();
	for (const stage of stages) for (const item of stage.items) if (item.target) deployed.add(item.target.id);
	const undeployed: EvaluationOrder["undeployed"] = [];
	for (const [id, entry] of rulesets) {
		if (entry.kind === "root" || entry.kind === "zone" || deployed.has(id) || !phaseIndex.has(entry.phase || "")) continue;
		const ruleCount = rulesByRuleset.get(id)?.length ?? 0;
		if (!ruleCount) continue;
		undeployed.push({ id, name: entry.name, type: entry.type, phase: entry.phase as string, scope: scopeLabel(entry), ruleCount });
	}
	undeployed.sort((a, b) => a.name.localeCompare(b.name));

	return { stages, undeployed };
}

/**
 * Walk each stage in order and mark what a match-everything terminating rule cuts off. An
 * account-level stopper cuts off everything after it, in every zone; a zone-level one only that
 * zone's later rules.
 */
function markUnreachable(stages: EvalStage[]): void {
	let accountStop: string | null = null;
	const zoneStop = new Map<string, string>();

	for (const stage of stages) {
		const inherited: string | null = accountStop ?? (stage.level === "zone" ? zoneStop.get(stage.scope) ?? null : null);
		let stop: string | null = inherited;

		for (const item of stage.items) {
			if (stop) {
				mark(item, stop);
				continue;
			}
			if (item.target) {
				// A deployment only reaches every request if its own expression is `true`.
				const everyRequest = item.row.enabled && item.row.expression.trim() === "true";
				if (!item.row.enabled) {
					for (const inner of item.target.items) inner.unreachable ??= "The execute rule that runs this ruleset is disabled.";
				} else {
					for (const inner of item.target.items) {
						if (stop) {
							inner.unreachable ??= stop;
						} else if (everyRequest && stopsEverything(inner.row, stage.phase)) {
							stop = `"${inner.row.name}" in ${item.target.name} stops every request before this rule.`;
						}
					}
				}
			} else if (stopsEverything(item.row, stage.phase)) {
				stop = `"${item.row.name}" stops every request before this rule.`;
			}
		}

		if (stop && !inherited) {
			if (stage.level === "account") accountStop = stop;
			else zoneStop.set(stage.scope, stop);
		}
	}
}

function mark(item: EvalItem, reason: string): void {
	item.unreachable ??= reason;
	for (const inner of item.target?.items ?? []) inner.unreachable ??= reason;
}

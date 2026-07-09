// Ported from cf-waf-rules-analyzer src/lib/aggregate.js — correlation of raw
// firewall events against ruleset metadata. TanStack now handles table
// filter/sort, so the hand-rolled filteredAndSorted* helpers were not ported.

import { TOP_HOST_LIMIT } from "./constants";
import { normalizeAction, ruleLevel, ruleType, titleCase } from "./format";
import type { ChildRuleRow, FirewallEvent, RuleMetaMap, RuleReviewRow, RulesetRow } from "./types";

function eventRuleId(event: FirewallEvent): string {
	return event.ruleId || "unknown";
}

function deriveRuleName(event: FirewallEvent, ruleMeta: RuleMetaMap): string {
	const id = eventRuleId(event);
	const meta = ruleMeta[id];
	if (meta?.name) return meta.name;
	if (event.source) return event.source + " / " + id;
	return id;
}

function deriveRuleset(event: FirewallEvent, ruleMeta: RuleMetaMap) {
	const ruleId = eventRuleId(event);
	const meta = ruleMeta[ruleId] || ({} as Partial<RuleMetaMap[string]>);
	const rulesetId = meta.rulesetId || (meta.isRuleset ? ruleId : "unknown-ruleset");
	const rulesetName =
		meta.ruleset || meta.rulesetName || (meta.isRuleset ? meta.name : "") || deriveRuleName(event, ruleMeta);
	return {
		ruleId,
		ruleName: deriveRuleName(event, ruleMeta),
		rulesetId,
		rulesetName: rulesetName || ruleId,
		source: event.source || meta.source || "waf",
		type: ruleType(meta),
		level: ruleLevel(meta),
		configuredAction: meta.action || "",
	};
}

export function aggregateRulesets(events: FirewallEvent[], ruleMeta: RuleMetaMap): RulesetRow[] {
	const rows = new Map<string, RulesetRow>();
	for (const event of events) {
		const derived = deriveRuleset(event, ruleMeta);
		const action = normalizeAction(event.action);
		const key = derived.rulesetId + "::" + derived.rulesetName + "::" + derived.level;
		if (!rows.has(key)) {
			rows.set(key, {
				ruleId: derived.rulesetId,
				ruleName: derived.rulesetName,
				source: derived.source,
				type: derived.type,
				level: derived.level,
				childRules: new Map(),
				total: 0,
				actions: {},
				hosts: new Map(),
				times: [],
				lastSeen: event.datetime || "",
			});
		}
		const row = rows.get(key)!;
		row.total += 1;
		row.actions[action] = (row.actions[action] || 0) + 1;
		const host = event.clientRequestHTTPHost || "";
		incrementChildRule(row, derived, action, event.datetime, host);
		if (host) row.hosts.set(host, (row.hosts.get(host) || 0) + 1);
		if (event.datetime) {
			const time = new Date(event.datetime).getTime();
			if (Number.isFinite(time)) row.times.push(time);
			if (!row.lastSeen || event.datetime > row.lastSeen) row.lastSeen = event.datetime;
		}
	}
	return Array.from(rows.values()).sort((a, b) => b.total - a.total);
}

function incrementChildRule(
	row: RulesetRow,
	derived: ReturnType<typeof deriveRuleset>,
	action: string,
	datetime: string | undefined,
	host: string,
) {
	if (!row.childRules.has(derived.ruleId)) {
		row.childRules.set(derived.ruleId, {
			id: derived.ruleId,
			name: derived.ruleName,
			configuredAction: derived.configuredAction,
			total: 0,
			actions: {},
			hosts: new Map(),
			lastSeen: datetime || "",
		});
	}
	const child = row.childRules.get(derived.ruleId)!;
	child.total += 1;
	child.actions[action] = (child.actions[action] || 0) + 1;
	if (host) child.hosts.set(host, (child.hosts.get(host) || 0) + 1);
	if (datetime && (!child.lastSeen || datetime > child.lastSeen)) child.lastSeen = datetime;
}

export function topHosts(row: RulesetRow): [string, number][] {
	return Array.from(row.hosts.entries()).sort((a, b) => b[1] - a[1]).slice(0, TOP_HOST_LIMIT);
}

export function topChildHost(rule: ChildRuleRow): [string, number] | null {
	if (!rule.hosts.size) return null;
	return Array.from(rule.hosts.entries()).sort((a, b) => b[1] - a[1])[0] || null;
}

// Shadowing/misconfig heuristic: configured action differs from the most-observed action.
export function actionDrift(rule: { configuredAction: string; actions: Record<string, number> }): { configured: string; observed: string } | null {
	if (!rule.configuredAction) return null;
	const configured = normalizeAction(rule.configuredAction);
	const observed = Object.entries(rule.actions).sort((a, b) => b[1] - a[1])[0]?.[0];
	if (observed && observed !== configured) return { configured, observed };
	return null;
}

export function actionSummary(actions: Record<string, number>): string {
	const sorted = Object.entries(actions).sort((a, b) => b[1] - a[1]);
	if (!sorted.length) return "-";
	const top = sorted.slice(0, 2).map(([action, count]) => `${titleCase(action)} ${count.toLocaleString()}`).join(", ");
	const extra = sorted.length > 2 ? ` +${sorted.length - 2}` : "";
	return top + extra;
}

export function countEventsByActions(events: FirewallEvent[], actions: string[]): number {
	const accepted = new Set(actions);
	return events.filter((event) => accepted.has(normalizeAction(event.action))).length;
}

/**
 * Flat per-rule view for the Rules Review page: every rule known from ruleset
 * metadata (even ones with no traffic), enriched with event stats when present.
 */
export function aggregateRules(events: FirewallEvent[], ruleMeta: RuleMetaMap): RuleReviewRow[] {
	const rows = new Map<string, RuleReviewRow>();

	const rowFor = (id: string, meta: RuleMetaMap[string] | undefined): RuleReviewRow => {
		if (!rows.has(id)) {
			rows.set(id, {
				id,
				name: meta?.name || id,
				ruleset: meta?.ruleset || meta?.rulesetName || "",
				rulesetId: meta?.rulesetId || "",
				type: ruleType(meta),
				level: ruleLevel(meta),
				configuredAction: meta?.action || "",
				enabled: meta?.enabled !== false,
				known: Boolean(meta),
				expression: meta?.expression || "",
				total: 0,
				actions: {},
				hosts: new Map(),
				paths: new Map(),
				times: [],
				lastSeen: "",
			});
		}
		return rows.get(id)!;
	};

	// Metadata rules first (skip ruleset-level entries; dedupe id/ref aliases).
	const seenEntries = new Set<RuleMetaMap[string]>();
	for (const [key, meta] of Object.entries(ruleMeta)) {
		if (!meta || meta.isRuleset) continue;
		const id = meta.ruleId || key;
		if (seenEntries.has(meta)) continue;
		seenEntries.add(meta);
		rowFor(id, meta);
	}

	for (const event of events) {
		const id = eventRuleId(event);
		const meta = ruleMeta[id];
		if (meta?.isRuleset) continue; // ruleset-level hits have no single rule to review
		const row = rowFor(meta?.ruleId || id, meta);
		const action = normalizeAction(event.action);
		row.total += 1;
		row.actions[action] = (row.actions[action] || 0) + 1;
		const host = event.clientRequestHTTPHost || "";
		if (host) row.hosts.set(host, (row.hosts.get(host) || 0) + 1);
		const path = event.clientRequestPath || "";
		if (path) row.paths.set(path, (row.paths.get(path) || 0) + 1);
		if (event.datetime) {
			const time = new Date(event.datetime).getTime();
			if (Number.isFinite(time)) row.times.push(time);
			if (!row.lastSeen || event.datetime > row.lastSeen) row.lastSeen = event.datetime;
		}
	}

	return Array.from(rows.values()).sort((a, b) => b.total - a.total);
}

export function topEntries(map: Map<string, number>, limit: number): [string, number][] {
	return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

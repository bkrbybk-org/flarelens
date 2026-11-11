// Ported from cf-waf-rules-analyzer src/lib/aggregate.js — correlation of raw
// firewall events against ruleset metadata. TanStack now handles table
// filter/sort, so the hand-rolled filteredAndSorted* helpers were not ported.

import { TOP_HOST_LIMIT } from "./constants";
import { normalizeAction, ruleLevel, ruleType, titleCase } from "./format";
import type { ChildRuleRow, FirewallEvent, RuleCountMap, RuleMetaMap, RuleReviewRow, RulesetRow, WafAggregates } from "./types";

/**
 * Fold the Worker's per-rule full counts into a map by rule id, or null when there are none —
 * no full counts at all, or a Worker older than the field — so callers fall back to the rows.
 */
export function ruleCountMap(aggregates: Pick<WafAggregates, "byRule"> | null | undefined): RuleCountMap | null {
	if (!aggregates?.byRule) return null;
	const map: RuleCountMap = new Map();
	for (const { ruleId, action, source, count } of aggregates.byRule) {
		const entry = map.get(ruleId) ?? { total: 0, actions: {}, source };
		const normalized = normalizeAction(action);
		entry.actions[normalized] = (entry.actions[normalized] || 0) + count;
		entry.total += count;
		entry.source ??= source;
		map.set(ruleId, entry);
	}
	return map;
}

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

/**
 * Rulesets with the rules that fired under them. With `counts`, every count is Cloudflare's full
 * count, and a rule the sample missed altogether still gets its row; hosts and timing stay what
 * the sampled rows show, since only the rows carry them.
 */
export function aggregateRulesets(events: FirewallEvent[], ruleMeta: RuleMetaMap, counts?: RuleCountMap | null): RulesetRow[] {
	const rows = new Map<string, RulesetRow>();
	const rowFor = (event: FirewallEvent, derived: ReturnType<typeof deriveRuleset>): RulesetRow => {
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
		return rows.get(key)!;
	};
	for (const event of events) {
		const derived = deriveRuleset(event, ruleMeta);
		const action = normalizeAction(event.action);
		const row = rowFor(event, derived);
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
	if (counts) {
		// Rules no sampled row reached: a row of their own, from what the counts know.
		const sampled = new Set(events.map(eventRuleId));
		for (const [ruleId, rule] of counts) {
			if (sampled.has(ruleId)) continue;
			const event: FirewallEvent = { ruleId, source: rule.source };
			const derived = deriveRuleset(event, ruleMeta);
			incrementChildRule(rowFor(event, derived), derived, "", undefined, "");
		}
		for (const row of rows.values()) {
			row.total = 0;
			row.actions = {};
			for (const child of row.childRules.values()) {
				const full = counts.get(child.id);
				if (full) {
					child.total = full.total;
					child.actions = { ...full.actions };
				}
				row.total += child.total;
				for (const [action, n] of Object.entries(child.actions)) row.actions[action] = (row.actions[action] || 0) + n;
			}
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
	if (!action) return; // a placeholder for a rule only the full counts know
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
 * With `counts`, a rule's total and actions are Cloudflare's full counts; hosts,
 * paths and timing still come from the sampled rows.
 */
export function aggregateRules(events: FirewallEvent[], ruleMeta: RuleMetaMap, counts?: RuleCountMap | null): RuleReviewRow[] {
	const rows = new Map<string, RuleReviewRow>();

	const rowFor = (id: string, meta: RuleMetaMap[string] | undefined): RuleReviewRow => {
		if (!rows.has(id)) {
			rows.set(id, {
				id,
				name: meta?.name || id,
				ruleset: meta?.ruleset || meta?.rulesetName || "",
				rulesetId: meta?.rulesetId || "",
				source: meta?.source || "",
				phase: meta?.phase || "",
				position: meta?.position,
				executes: meta?.executes,
				overrides: meta?.overrides,
				categories: meta?.categories,
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

	if (counts) {
		const full = new Map<string, { total: number; actions: Record<string, number> }>();
		for (const [id, rule] of counts) {
			const meta = ruleMeta[id];
			if (meta?.isRuleset) continue;
			const rowId = meta?.ruleId || id;
			rowFor(rowId, meta);
			// Two ids can name one rule (id and ref): their counts add up.
			const entry = full.get(rowId) ?? { total: 0, actions: {} };
			entry.total += rule.total;
			for (const [action, n] of Object.entries(rule.actions)) entry.actions[action] = (entry.actions[action] || 0) + n;
			full.set(rowId, entry);
		}
		for (const [rowId, entry] of full) {
			const row = rows.get(rowId)!;
			row.total = entry.total;
			row.actions = entry.actions;
		}
	}

	return Array.from(rows.values()).sort((a, b) => b.total - a.total);
}

export interface RuleGroup {
	/** rulesetId, else the ruleset label; "" for rules the metadata does not know. */
	key: string;
	name: string;
	/**
	 * Zone the ruleset belongs to, for zone custom rulesets only — every zone's entrypoint is
	 * called "default" or "zone", so the name alone does not say which. Empty for managed
	 * rulesets: one managed ruleset id is deployed to many zones, and naming one would be wrong.
	 */
	zone: string;
	type: string;
	level: string;
	rules: RuleReviewRow[];
	total: number;
	disabled: number;
	drift: number;
}

/**
 * Rules grouped under the ruleset that owns them, busiest ruleset first.
 *
 * Keyed on the ruleset id rather than its name: two zones' custom rulesets are both called
 * "default", and folding them together would put one zone's rules under the other's. Rules the
 * metadata does not know — an event whose rule id resolved to nothing — collect in one group
 * last, rather than each posing as a ruleset of its own. Rule order inside a group is kept.
 */
export function groupRulesByRuleset(rows: RuleReviewRow[]): RuleGroup[] {
	const groups = new Map<string, RuleGroup>();
	for (const row of rows) {
		const key = row.rulesetId || row.ruleset;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				name: row.ruleset || row.rulesetId || "Unattributed rules",
				zone: key && row.type === "custom" && row.source.startsWith("zone:") ? row.source.slice("zone:".length) : "",
				type: key ? row.type : "",
				level: key ? row.level : "",
				rules: [],
				total: 0,
				disabled: 0,
				drift: 0,
			};
			groups.set(key, group);
		}
		group.rules.push(row);
		group.total += row.total;
		if (!row.enabled) group.disabled += 1;
		if (actionDrift(row)) group.drift += 1;
	}
	return Array.from(groups.values()).sort((a, b) => {
		if (!a.key !== !b.key) return a.key ? -1 : 1;
		return b.total - a.total || a.name.localeCompare(b.name);
	});
}

export function topEntries(map: Map<string, number>, limit: number): [string, number][] {
	return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export interface RuleEventDetail {
	total: number;
	actions: Record<string, number>;
	/** Sampled rows behind the top lists; equal to `total` when there were no full counts. */
	sampled: number;
	paths: Map<string, number>;
	hosts: Map<string, number>;
	countries: Map<string, number>;
	ips: Map<string, number>;
	times: number[];
}

/**
 * Per-rule event breakdown for the drill-down drawer. With the rule's full counts, the total and
 * actions are those; the top lists and timing stay the sample's, and `sampled` says how many
 * rows they were drawn from.
 */
export function ruleEventDetail(events: FirewallEvent[], ruleId: string, counts?: RuleCountMap | null): RuleEventDetail {
	const detail: RuleEventDetail = {
		total: 0,
		actions: {},
		sampled: 0,
		paths: new Map(),
		hosts: new Map(),
		countries: new Map(),
		ips: new Map(),
		times: [],
	};
	const bump = (map: Map<string, number>, key: string | undefined) => {
		if (key) map.set(key, (map.get(key) || 0) + 1);
	};
	for (const event of events) {
		if (eventRuleId(event) !== ruleId) continue;
		detail.total += 1;
		const action = normalizeAction(event.action);
		detail.actions[action] = (detail.actions[action] || 0) + 1;
		bump(detail.paths, event.clientRequestPath);
		bump(detail.hosts, event.clientRequestHTTPHost);
		bump(detail.countries, event.clientCountryName);
		bump(detail.ips, event.clientIP);
		if (event.datetime) {
			const time = new Date(event.datetime).getTime();
			if (Number.isFinite(time)) detail.times.push(time);
		}
	}
	detail.sampled = detail.total;
	const full = counts?.get(ruleId);
	if (full) {
		detail.total = full.total;
		detail.actions = { ...full.actions };
	}
	return detail;
}

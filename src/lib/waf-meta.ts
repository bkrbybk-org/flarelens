// Ported from cf-waf-rules-analyzer worker/index.js: flattens Cloudflare
// rulesets (account + zone scopes, managed execute targets, custom firewall
// entrypoint) into a rule-id/ref keyed metadata map the frontend correlates
// firewall events against.

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MANAGED_RULESET_KIND = "managed";
const CUSTOM_FIREWALL_PHASE = "http_request_firewall_custom";

export interface RuleMetaEntry {
	name: string;
	ruleId?: string;
	source: string;
	type: string;
	level: string;
	phase: string;
	ruleset: string;
	rulesetName?: string;
	rulesetId: string;
	kind: string;
	action?: string;
	enabled?: boolean;
	expression?: string;
	isRuleset?: boolean;
}

export type RuleMetaMap = Record<string, RuleMetaEntry>;

export interface RulesetScope {
	kind: "accounts" | "zones";
	id: string;
	source: string;
}

interface CfRule {
	id?: string;
	ref?: string;
	description?: string;
	name?: string;
	action?: string;
	enabled?: boolean;
	expression?: unknown;
	action_parameters?: { id?: string; overrides?: { ruleset?: { description?: string } } };
}

interface CfRuleset {
	id?: string;
	name?: string;
	description?: string;
	kind?: string;
	phase?: string;
	rules?: CfRule[];
}

interface CfBody {
	success?: boolean;
	errors?: { message: string }[];
	result?: unknown;
	result_info?: { total_pages?: number };
}

export class UpstreamError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "UpstreamError";
	}
}

async function cfFetch(url: string, token: string): Promise<CfBody> {
	const response = await fetch(url, {
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});
	let body: CfBody;
	try {
		body = await response.json();
	} catch {
		body = { success: false, errors: [{ message: `Cloudflare API returned non-JSON response (${response.status})` }] };
	}
	if (!response.ok || body.success === false) {
		throw new UpstreamError(body.errors?.[0]?.message || `Cloudflare API returned ${response.status}`, response.status);
	}
	return body;
}

async function tryCfFetch(url: string, token: string): Promise<CfBody | null> {
	try {
		return await cfFetch(url, token);
	} catch {
		return null;
	}
}

function rulesetContext(ruleset: CfRuleset, source: string) {
	const parentRuleset = ruleset.name || ruleset.description || ruleset.id || "";
	return {
		source,
		parentRuleset,
		level: String(source || "").startsWith("zone") ? "zone" : "account",
		type: ruleset.kind === MANAGED_RULESET_KIND ? "managed" : "custom",
		phase: ruleset.phase || "",
		kind: ruleset.kind || "",
		rulesetId: ruleset.id || "",
	};
}

type RulesetContext = ReturnType<typeof rulesetContext>;

function addRulesetEntry(meta: RuleMetaMap, ruleset: CfRuleset, context: RulesetContext) {
	if (!ruleset.id) return;
	meta[ruleset.id] = {
		name: context.parentRuleset || ruleset.id,
		source: context.source,
		type: context.type,
		level: context.level,
		isRuleset: true,
		rulesetId: ruleset.id,
		ruleset: context.parentRuleset || ruleset.id,
		phase: context.phase,
		kind: context.kind,
	};
}

function addRuleEntry(meta: RuleMetaMap, rule: CfRule, context: RulesetContext) {
	const name = rule.description || rule.name || context.parentRuleset || rule.ref || rule.id || "";
	const entry: RuleMetaEntry = {
		name,
		ruleId: rule.id || rule.ref || "",
		source: context.source,
		type: context.type,
		level: context.level,
		phase: context.phase,
		ruleset: context.parentRuleset,
		rulesetName: context.parentRuleset,
		rulesetId: context.rulesetId,
		kind: context.kind,
		action: rule.action || "",
		enabled: rule.enabled !== false,
		expression: typeof rule.expression === "string" ? rule.expression.slice(0, 500) : "",
	};
	if (rule.id) meta[rule.id] = entry;
	if (rule.ref) meta[rule.ref] = entry;
}

function addManagedExecuteEntry(meta: RuleMetaMap, rule: CfRule, context: RulesetContext) {
	const managedRulesetId = rule.action_parameters?.id;
	if (!managedRulesetId) return;
	const managedRulesetName =
		rule.description || rule.action_parameters?.overrides?.ruleset?.description || managedRulesetId;
	meta[managedRulesetId] = {
		name: managedRulesetName,
		source: context.source,
		type: MANAGED_RULESET_KIND,
		level: context.level,
		phase: context.phase,
		ruleset: managedRulesetName,
		rulesetName: managedRulesetName,
		rulesetId: managedRulesetId,
		kind: MANAGED_RULESET_KIND,
		isRuleset: true,
	};
}

export function collectRulesetMeta(meta: RuleMetaMap, ruleset: CfRuleset | null, source: string) {
	if (!ruleset) return;
	const context = rulesetContext(ruleset, source);
	addRulesetEntry(meta, ruleset, context);
	for (const rule of ruleset.rules || []) {
		addRuleEntry(meta, rule, context);
		addManagedExecuteEntry(meta, rule, context);
	}
}

// Rulesets referenced by execute-action rules (managed deployments) need their
// own detail fetch so child managed rules resolve to names.
function rulesetDetailIds(rulesets: CfRuleset[]): Set<string> {
	const ids = new Set<string>();
	for (const ruleset of rulesets) {
		if (ruleset.id) ids.add(ruleset.id);
		for (const rule of ruleset.rules || []) {
			if (rule.action === "execute" && rule.action_parameters?.id) {
				ids.add(rule.action_parameters.id);
			}
		}
	}
	return ids;
}

export async function collectRulesetsForScope(scope: RulesetScope, token: string, meta: RuleMetaMap): Promise<void> {
	const list = await cfFetch(`${CF_API_BASE}/${scope.kind}/${encodeURIComponent(scope.id)}/rulesets`, token);
	const rulesets = (list.result as CfRuleset[] | undefined) || [];

	for (const ruleset of rulesets) {
		collectRulesetMeta(meta, ruleset, scope.source);
	}

	for (const id of rulesetDetailIds(rulesets)) {
		const detail = await tryCfFetch(
			`${CF_API_BASE}/${scope.kind}/${encodeURIComponent(scope.id)}/rulesets/${encodeURIComponent(id)}`,
			token,
		);
		if (detail?.result) {
			collectRulesetMeta(meta, detail.result as CfRuleset, scope.source);
		}
	}

	const entrypoint = await tryCfFetch(
		`${CF_API_BASE}/${scope.kind}/${encodeURIComponent(scope.id)}/rulesets/phases/${CUSTOM_FIREWALL_PHASE}/entrypoint`,
		token,
	);
	if (entrypoint?.result) {
		collectRulesetMeta(meta, entrypoint.result as CfRuleset, scope.source);
	}
}

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
	/** Zero-based index of the rule within its ruleset — its place in evaluation order. */
	position?: number;
	/** For an `execute` rule: the id of the ruleset it runs. */
	executes?: string;
	/**
	 * For a ruleset run by an `execute` rule: where it is deployed. Rules inside it run at that
	 * execute rule's position in the entrypoint, in their own order.
	 */
	deployment?: RulesetDeployment;
	/**
	 * Set on a ruleset entry known only from the execute rule that deploys it, before (or
	 * without) the ruleset itself being read. The real entry replaces it.
	 */
	placeholder?: boolean;
}

export interface RulesetDeployment {
	entrypointId: string;
	position: number;
	enabled: boolean;
	/** Which requests the deployment applies to; "true" is every request. */
	expression: string;
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
	// Where it is deployed may have been learned first, from the execute rule; keep it.
	const deployment = meta[ruleset.id]?.deployment;
	meta[ruleset.id] = {
		deployment,
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

function addRuleEntry(meta: RuleMetaMap, rule: CfRule, context: RulesetContext, position: number) {
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
		position,
		executes: rule.action === "execute" ? rule.action_parameters?.id : undefined,
	};
	if (rule.id) meta[rule.id] = entry;
	if (rule.ref) meta[rule.ref] = entry;
}

function addExecuteTargetEntry(meta: RuleMetaMap, rule: CfRule, context: RulesetContext, position: number) {
	const targetId = rule.action_parameters?.id;
	if (!targetId || !context.rulesetId) return;
	const deployment: RulesetDeployment = {
		entrypointId: context.rulesetId,
		position,
		enabled: rule.enabled !== false,
		expression: typeof rule.expression === "string" ? rule.expression.slice(0, 500) : "",
	};
	const existing = meta[targetId];
	// The ruleset's own entry, once read, is the authority on its name and kind — an execute
	// rule only says where it runs. Overwriting it here used to relabel account custom rulesets
	// as managed, whenever the deploying rule happened to be read after the ruleset itself.
	if (existing && !existing.placeholder) {
		meta[targetId] = { ...existing, deployment };
		return;
	}
	const name = rule.description || rule.action_parameters?.overrides?.ruleset?.description || targetId;
	// An account root in the custom-rules phase can only deploy custom rulesets; the managed
	// phase deploys managed ones.
	const type = context.phase === "http_request_firewall_managed" ? MANAGED_RULESET_KIND : "custom";
	meta[targetId] = {
		name,
		source: context.source,
		type,
		level: context.level,
		phase: context.phase,
		ruleset: name,
		rulesetName: name,
		rulesetId: targetId,
		kind: type,
		isRuleset: true,
		placeholder: true,
		deployment,
	};
}

export function collectRulesetMeta(meta: RuleMetaMap, ruleset: CfRuleset | null, source: string) {
	if (!ruleset) return;
	const context = rulesetContext(ruleset, source);
	addRulesetEntry(meta, ruleset, context);
	(ruleset.rules || []).forEach((rule, position) => {
		addRuleEntry(meta, rule, context, position);
		if (rule.action === "execute") addExecuteTargetEntry(meta, rule, context, position);
	});
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

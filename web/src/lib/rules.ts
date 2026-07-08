import type { CfPolicy } from "../types";

export interface RuleContext {
	groupName: (id: string) => string;
	idpName: (id: string) => string;
}

// Translate a single Access rule object ({ type: {...} }) into a human-readable sentence.
export function describeRule(rule: unknown, ctx: RuleContext): string {
	if (typeof rule !== "object" || rule === null) {
		return JSON.stringify(rule);
	}
	const key = Object.keys(rule)[0];
	if (!key) {
		return JSON.stringify(rule);
	}
	const val = ((rule as Record<string, unknown>)[key] || {}) as Record<string, string>;
	switch (key) {
		case "email": return `Email is ${val.email}`;
		case "email_domain": return `Emails ending in @${val.domain}`;
		case "email_list": return `Email in list ${val.id}`;
		case "everyone": return "Everyone";
		case "certificate": return "Valid client certificate";
		case "common_name": return `Certificate CN is ${val.common_name}`;
		case "ip": return `IP in ${val.ip}`;
		case "ip_list": return `IP in list ${val.id}`;
		case "group": return `Member of group "${ctx.groupName(val.id)}"`;
		case "geo": return `Country is ${val.country_code}`;
		case "auth_method": return `Auth method is ${val.auth_method}`;
		case "login_method": return `Login via ${ctx.idpName(val.id)}`;
		case "service_token": return `Service token ${val.token_id}`;
		case "any_valid_service_token": return "Any valid service token";
		case "device_posture": return `Device posture check ${val.integration_uid}`;
		case "external_evaluation": return `External evaluation at ${val.evaluate_url}`;
		case "azureAD": return `Entra ID group ${val.id}`;
		case "gsuite": return `Google Workspace group ${val.email}`;
		case "github-organization": return `GitHub org ${val.name}${val.team ? ` team ${val.team}` : ""}`;
		case "okta": return `Okta group ${val.name || val.email || val.id}`;
		case "saml": return `SAML attribute ${val.attribute_name} = ${val.attribute_value}`;
		case "auth_context": return `Entra auth context ${val.ac_id || val.id}`;
		default: return `${key}: ${JSON.stringify((rule as Record<string, unknown>)[key])}`;
	}
}

export const RULE_SECTIONS = [
	{ field: "include", label: "Include (any of)" },
	{ field: "require", label: "Require (all of)" },
	{ field: "exclude", label: "Exclude" },
] as const;

export type DecisionTone = "allow" | "deny" | "warn" | "neutral";

// allow = green, deny = red, bypass = amber (weakens protection),
// non_identity / service_auth = neutral (legitimate modes, not denials)
export function decisionTone(decision: string): DecisionTone {
	switch (decision.toLowerCase()) {
		case "allow": return "allow";
		case "deny": return "deny";
		case "bypass": return "warn";
		default: return "neutral";
	}
}

// Reusable policies attached to apps may come back as id-only references;
// merge in the account-level definition so rules can render.
export function resolvePolicy(policy: CfPolicy, reusableMap: Record<string, CfPolicy>): CfPolicy {
	const hasRules = Array.isArray(policy.include) || Array.isArray(policy.exclude) || Array.isArray(policy.require);
	if (!hasRules && policy.id && policy.id in reusableMap) {
		return { ...reusableMap[policy.id], ...policy, reusable: true };
	}
	return policy;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatLocalDateTime(val: unknown): string {
	const d = new Date(String(val));
	if (Number.isNaN(d.getTime())) {
		return String(val);
	}
	const day = String(d.getDate()).padStart(2, "0");
	const month = MONTHS[d.getMonth()];
	const year = d.getFullYear();
	const hours = String(d.getHours()).padStart(2, "0");
	const minutes = String(d.getMinutes()).padStart(2, "0");
	return `${day}-${month}-${year} ${hours}:${minutes}`;
}

export function formatColumnLabel(col: string): string {
	if (col === "updated_at") return "Updated";
	if (col === "created_at") return "Created";
	if (col === "allowed_idps") return "Identity Providers";
	if (col === "self_hosted_domains") return "Domains";
	return col.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

// Pure audit-signal checks that back the Findings page. Kept dependency-free
// of React so every check is unit-testable in isolation; FindingsPage only
// wires these together with whichever section data happens to be loaded.
import type { CfApp, CfGroup, CfPolicy } from "../types";
import { resolvePolicy } from "./rules";
import { actionDrift } from "./waf/aggregate";
import type { RuleReviewRow } from "./waf/types";
import type { CacheAnalysis } from "../features/cache/types";

export type Severity = "high" | "medium" | "low";
export type FindingSource = "access" | "groups" | "waf" | "cache" | "tunnels" | "zone-health" | "pqc" | "dns" | "bots";

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	source: FindingSource;
	href: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_ORDER: Record<FindingSource, number> = {
	access: 0, groups: 1, tunnels: 2, waf: 3, cache: 4, "zone-health": 5, pqc: 6, dns: 7, bots: 8,
};

export function sortFindings(findings: Finding[]): Finding[] {
	return [...findings].sort(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
	);
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
	for (const f of findings) counts[f.severity]++;
	return counts;
}

function isEveryoneRule(rule: unknown): boolean {
	return typeof rule === "object" && rule !== null && "everyone" in (rule as Record<string, unknown>);
}

function reachableByEveryone(policy: CfPolicy): boolean {
	const include = policy.include || [];
	const hasEveryone = (include as unknown[]).some(isEveryoneRule);
	const requireEmpty = !policy.require || (policy.require as unknown[]).length === 0;
	return hasEveryone && requireEmpty;
}

/** Broad admission rule kinds: satisfying one alone (domain membership, login method, any service
 * token) is not evidence of who or what is on the other end, unlike an email/group/IP match. */
const BROAD_INCLUDE_KINDS = new Set(["email_domain", "login_method", "any_valid_service_token"]);

function isBroadIncludeRule(rule: unknown): boolean {
	if (typeof rule !== "object" || rule === null) return false;
	const key = Object.keys(rule as Record<string, unknown>)[0];
	return key !== undefined && BROAD_INCLUDE_KINDS.has(key);
}

// An allow policy whose include is entirely broad-kind rules and has no require is one condition
// away from "reachable by everyone" — anyone in the domain/login method/holding any service token
// gets in with nothing else checked. Distinct from reachableByEveryone (an explicit everyone
// rule): this is the same shape reached through a wider-than-intended domain or IdP instead.
function broadAllowNoRequire(policy: CfPolicy): boolean {
	if ((policy.decision || "").toLowerCase() !== "allow") return false;
	const requireEmpty = !policy.require || (policy.require as unknown[]).length === 0;
	if (!requireEmpty) return false;
	const include = (policy.include || []) as unknown[];
	return include.length > 0 && include.every(isBroadIncludeRule);
}

/**
 * Minutes for a Go-style duration string ("24h", "730h", "30m", "15m", "1h30m"). Cloudflare
 * Access's session_duration field is exactly this format. Returns null — never 0 — for a missing
 * or unparseable value, so a field this dashboard cannot read is never mistaken for a short
 * session.
 */
const DURATION_TOKEN_RE = /(\d+(?:\.\d+)?)(h|m|s)/g;
const DURATION_SHAPE_RE = /^(?:\d+(?:\.\d+)?(?:h|m|s))+$/;

export function parseSessionDuration(s: string | undefined | null): number | null {
	if (!s) return null;
	const trimmed = s.trim();
	if (!DURATION_SHAPE_RE.test(trimmed)) return null;
	let minutes = 0;
	for (const match of trimmed.matchAll(DURATION_TOKEN_RE)) {
		const value = Number.parseFloat(match[1]);
		const unit = match[2];
		if (unit === "h") minutes += value * 60;
		else if (unit === "m") minutes += value;
		else minutes += value / 60; // seconds
	}
	return minutes;
}

const HOUR_MINUTES = 60;
const LONG_SESSION_MINUTES = 24 * HOUR_MINUTES;
const VERY_LONG_SESSION_MINUTES = 7 * 24 * HOUR_MINUTES;

// Does any rule in this policy reference the group id? Shared by the Access
// Groups "used by" cross-reference and the unreferenced-group finding below —
// extracted here so neither copy drifts from the other.
export function policyReferencesGroup(policy: CfPolicy, groupId: string): boolean {
	for (const field of ["include", "exclude", "require"] as const) {
		for (const rule of policy[field] || []) {
			if (
				typeof rule === "object" && rule !== null &&
				(rule as { group?: { id?: string } }).group?.id === groupId
			) {
				return true;
			}
		}
	}
	return false;
}

// group id → app names whose policies reference it
/**
 * Group id → names of the applications whose policies reference it.
 *
 * Policies are resolved through `reusableMap` first. A reusable policy attached to an app can
 * come back as a bare reference with no include/exclude/require, and matching against that raw
 * object finds nothing — so a group used only through a reusable policy would report as
 * unreferenced. That is the dangerous direction to be wrong in: "unreferenced" is the signal an
 * auditor uses to decide a group is dead and can be deleted.
 *
 * `reusableMap` is optional so a caller without it degrades to the old behaviour rather than
 * throwing, but every caller in this app passes it.
 */
export function groupUsedBy(
	groups: CfGroup[],
	apps: CfApp[],
	reusableMap: Record<string, CfPolicy> = {},
): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const group of groups) {
		const names: string[] = [];
		for (const app of apps) {
			if (app.policies.some((p) => policyReferencesGroup(resolvePolicy(p, reusableMap), group.id))) {
				names.push(app.name || app.id);
			}
		}
		map.set(group.id, names);
	}
	return map;
}

/**
 * Reusable policy id → names of the applications that attach it.
 *
 * An application attaches a reusable policy by reference: the app's own policy entry carries the
 * reusable policy's id and no rules of its own, which is exactly what resolvePolicy keys on. A
 * policy nothing references is worth seeing — it is either dead configuration or a policy someone
 * expected to be in force.
 */
export function reusablePolicyUsedBy(policies: CfPolicy[], apps: CfApp[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const policy of policies) {
		const names: string[] = [];
		for (const app of apps) {
			if (app.policies.some((attached) => attached.id === policy.id)) {
				names.push(app.name || app.id);
			}
		}
		map.set(policy.id, names);
	}
	return map;
}

export function accessFindings(apps: CfApp[], reusableMap: Record<string, CfPolicy>): Finding[] {
	const findings: Finding[] = [];
	for (const app of apps) {
		const label = app.name || app.id;

		// These read straight off the app object, independent of whether its policies fetch
		// succeeded, so they run before the policies_error branch below can `continue` past them.
		const sessionMinutes = parseSessionDuration(app.session_duration);
		if (sessionMinutes !== null) {
			if (sessionMinutes >= VERY_LONG_SESSION_MINUTES) {
				findings.push({
					id: `access:long-session:${app.id}`,
					severity: "medium",
					title: `${label}: very long session duration`,
					detail: `session_duration is "${app.session_duration}" (7 days or more) — a stolen or leaked token stays valid for a long time.`,
					source: "access",
					href: "#/access",
				});
			} else if (sessionMinutes > LONG_SESSION_MINUTES) {
				findings.push({
					id: `access:long-session:${app.id}`,
					severity: "low",
					title: `${label}: long session duration`,
					detail: `session_duration is "${app.session_duration}" (over 24h) — longer than a typical workday before re-authentication is required.`,
					source: "access",
					href: "#/access",
				});
			}
		}

		if (app.http_only_cookie_attribute === false) {
			findings.push({
				id: `access:cookie-not-httponly:${app.id}`,
				severity: "low",
				title: `${label}: session cookie readable by scripts`,
				detail: "http_only_cookie_attribute is disabled, so page JavaScript can read the Access session cookie — a bigger blast radius if the app has an XSS bug.",
				source: "access",
				href: "#/access",
			});
		}

		const cors = app.cors_headers;
		if (cors) {
			const wildcard = cors.allow_all_origins === true || (Array.isArray(cors.allowed_origins) && cors.allowed_origins.includes("*"));
			if (wildcard) {
				const withCredentials = cors.allow_credentials === true;
				findings.push({
					id: `access:cors-wildcard:${app.id}`,
					severity: withCredentials ? "medium" : "low",
					title: `${label}: CORS allows any origin${withCredentials ? " with credentials" : ""}`,
					detail: withCredentials
						? "cors_headers allows all origins and allow_credentials is true — any site can make authenticated cross-origin requests and read the response."
						: "cors_headers allows all origins — any site can make cross-origin requests to this app.",
					source: "access",
					href: "#/access",
				});
			}
		}

		if (app.policies_error) {
			findings.push({
				id: `access:policies-error:${app.id}`,
				severity: "medium",
				title: `${label}: policies could not be fetched`,
				detail: "This app's posture is unknown — the API call for its policies failed.",
				source: "access",
				href: "#/access",
			});
			continue;
		}

		if (app.policies.length === 0) {
			findings.push({
				id: `access:no-policy:${app.id}`,
				severity: "high",
				title: `${label}: no Access policy`,
				detail: "No policy is attached to this application; the account-level default decision applies.",
				source: "access",
				href: "#/access",
			});
		}

		for (const raw of app.policies) {
			const policy = resolvePolicy(raw, reusableMap);
			const policyLabel = policy.name || policy.id;

			if (reachableByEveryone(policy)) {
				findings.push({
					id: `access:everyone:${app.id}:${policy.id}`,
					severity: "high",
					title: `${label}: "${policyLabel}" allows everyone`,
					detail: "Include contains an everyone rule and require is empty — reachable by anyone who can reach the URL.",
					source: "access",
					href: "#/access",
				});
			}

			if ((policy.decision || "").toLowerCase() === "bypass") {
				findings.push({
					id: `access:bypass:${app.id}:${policy.id}`,
					severity: "medium",
					title: `${label}: "${policyLabel}" bypasses Access`,
					detail: "This policy's decision is bypass — it skips Access entirely for matching requests.",
					source: "access",
					href: "#/access",
				});
			}

			if (!reachableByEveryone(policy) && broadAllowNoRequire(policy)) {
				findings.push({
					id: `access:broad-allow:${app.id}:${policy.id}`,
					severity: "low",
					title: `${label}: "${policyLabel}" allows a broad group with no second check`,
					detail: "Every include rule is a broad kind (email domain, login method, or any valid service token) and require is empty — anyone matching is admitted with no additional condition.",
					source: "access",
					href: "#/access",
				});
			}
		}
	}
	return findings;
}

export function groupsFindings(
	groups: CfGroup[],
	apps: CfApp[],
	reusableMap: Record<string, CfPolicy> = {},
): Finding[] {
	const usedBy = groupUsedBy(groups, apps, reusableMap);
	const findings: Finding[] = [];
	for (const group of groups) {
		const refs = usedBy.get(group.id) || [];
		if (refs.length === 0) {
			findings.push({
				id: `groups:unreferenced:${group.id}`,
				severity: "low",
				title: `${group.name || group.id}: unreferenced group`,
				detail: "Not used by any application policy — hygiene candidate for cleanup.",
				source: "groups",
				href: "#/groups",
			});
		}
	}
	return findings;
}

export function wafFindings(rows: RuleReviewRow[]): Finding[] {
	const findings: Finding[] = [];
	for (const row of rows) {
		const drift = actionDrift(row);
		if (drift) {
			findings.push({
				id: `waf:drift:${row.id}`,
				severity: "medium",
				title: `${row.name}: action drift`,
				detail: `Configured action is "${drift.configured}" but the most common observed action is "${drift.observed}".`,
				source: "waf",
				href: "#/waf?tab=rules",
			});
		}
	}
	return findings;
}

export function cacheFindings(analysis: CacheAnalysis): Finding[] {
	const findings: Finding[] = [];
	analysis.insights.forEach((insight, i) => {
		findings.push({
			id: `cache:insight:${analysis.zoneId}:${i}`,
			severity: insight.severity === "warn" ? "medium" : "low",
			title: insight.severity === "warn" ? `${analysis.zoneName}: cache insight` : `${analysis.zoneName}: cache note`,
			detail: insight.message,
			source: "cache",
			href: `#/cache?zone=${analysis.zoneId}`,
		});
	});

	if (analysis.health && (analysis.health.grade === "D" || analysis.health.grade === "F")) {
		findings.push({
			id: `cache:health:${analysis.zoneId}`,
			severity: "medium",
			title: `${analysis.zoneName}: low cache health grade (${analysis.health.grade})`,
			detail: `Hit ratio ${analysis.health.ratio.toFixed(1)}% — cache rule configuration likely needs review.`,
			source: "cache",
			href: `#/cache?zone=${analysis.zoneId}`,
		});
	}

	return findings;
}

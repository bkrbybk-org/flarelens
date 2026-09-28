import type { CfApp, CfGroup, CfIdp, CfList, CfPolicy } from "../types";
import { resolvePolicy } from "./rules";

/**
 * "Would this person get into this application?" — Access policy evaluation, offline.
 *
 * Follows Cloudflare's documented order: Bypass and Service Auth policies first, top to bottom;
 * then Allow and Block, top to bottom; the first Allow or Block that matches ends evaluation; and
 * with no match the answer is deny. Within a policy, Include is OR, Require is AND, Exclude is NOT.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
 *
 * Three-valued throughout. A rule the tester cannot decide — an identity-provider group nobody
 * entered, a device posture check, a list too long to have been read in full — is `unknown`, and
 * an unknown that could change the outcome makes the verdict "depends" rather than a guess. The
 * same Kleene rules as the wirefilter evaluator: true OR unknown is true, false AND unknown is false.
 */

export type Tri = true | false | "unknown";

export interface TestIdentity {
	/** "user" logs in through an identity provider; "service" presents a service token instead. */
	mode: "user" | "service";
	email?: string;
	/** Identity provider id the user logs in with. */
	idpId?: string;
	/** Group ids or names the identity provider asserts (Entra ID, Okta, Google, GitHub, SAML). */
	idpGroups?: string[];
	/** Two-letter country code. */
	country?: string;
	ip?: string;
	/** e.g. "mfa", "pwd", "hwk". */
	authMethod?: string;
	/** Service mode: the token's client id or token id. */
	serviceTokenId?: string;
}

export interface EvalContext {
	groups: Record<string, CfGroup>;
	lists: Record<string, CfList>;
	idps: Record<string, CfIdp>;
	reusable: Record<string, CfPolicy>;
}

export interface RuleResult {
	rule: unknown;
	result: Tri;
	/** Why, when the answer is not obvious from the rule itself. */
	note?: string;
}

export interface PolicyTrace {
	policy: CfPolicy;
	decision: string;
	precedence: number;
	match: Tri;
	include: RuleResult[];
	require: RuleResult[];
	exclude: RuleResult[];
}

export type Verdict = "allowed" | "blocked" | "bypass" | "service" | "denied-default" | "idp-not-allowed" | "depends";

export interface AccessTestResult {
	verdict: Verdict;
	/** The policy that decided it, when one did. */
	decidedBy?: PolicyTrace;
	/** Policies that could not be decided and sit before the deciding one — what "depends" hinges on. */
	undecided: PolicyTrace[];
	trace: PolicyTrace[];
}

// ---------------------------------------------------------------------------
// Three-valued logic

function anyOf(values: Tri[]): Tri {
	if (values.some((v) => v === true)) return true;
	return values.some((v) => v === "unknown") ? "unknown" : false;
}

function allOf(values: Tri[]): Tri {
	if (values.some((v) => v === false)) return false;
	return values.some((v) => v === "unknown") ? "unknown" : true;
}

function not(v: Tri): Tri {
	return v === "unknown" ? "unknown" : !v;
}

// ---------------------------------------------------------------------------
// Addresses

function ipv4ToInt(ip: string): number | null {
	const parts = ip.trim().split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
		n = n * 256 + Number(part);
	}
	return n;
}

/** IPv4 CIDR or exact address. IPv6 is compared exactly — a range there is reported as unknown. */
export function ipMatches(ip: string, range: string): Tri {
	const [base, bitsRaw] = range.trim().split("/");
	const a = ipv4ToInt(ip);
	const b = ipv4ToInt(base);
	if (a !== null && b !== null) {
		const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
		if (!Number.isInteger(bits) || bits < 0 || bits > 32) return "unknown";
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return ((a & mask) >>> 0) === ((b & mask) >>> 0);
	}
	if (a !== null || b !== null) return false; // one side v4, the other not
	if (bitsRaw === undefined) return ip.trim().toLowerCase() === base.toLowerCase();
	return "unknown";
}

// ---------------------------------------------------------------------------
// Rules

const lower = (s: string | undefined) => (s ?? "").trim().toLowerCase();

function hasGroup(identity: TestIdentity, ...candidates: (string | undefined)[]): Tri {
	if (!identity.idpGroups || identity.idpGroups.length === 0) return "unknown";
	const have = new Set(identity.idpGroups.map(lower));
	return candidates.some((c) => c && have.has(lower(c)));
}

function evalRule(rule: unknown, identity: TestIdentity, ctx: EvalContext, visiting: Set<string>): RuleResult {
	if (!rule || typeof rule !== "object") return { rule, result: "unknown", note: "Unreadable rule." };
	const key = Object.keys(rule)[0];
	const val = ((rule as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
	const user = identity.mode === "user";
	const r = (result: Tri, note?: string): RuleResult => ({ rule, result, ...(note ? { note } : {}) });

	switch (key) {
		case "everyone":
			return r(true);
		case "email":
			if (!user) return r(false, "A service token carries no email.");
			return identity.email ? r(lower(identity.email) === lower(val.email as string)) : r("unknown", "No email entered.");
		case "email_domain": {
			if (!user) return r(false, "A service token carries no email.");
			if (!identity.email) return r("unknown", "No email entered.");
			return r(lower(identity.email).endsWith(`@${lower(val.domain as string)}`));
		}
		case "email_list": {
			if (!user) return r(false, "A service token carries no email.");
			if (!identity.email) return r("unknown", "No email entered.");
			const list = ctx.lists[val.id as string];
			if (!list || list.error) return r("unknown", "This list could not be read.");
			if (list.items.some((item) => lower(item) === lower(identity.email))) return r(true);
			return list.items_truncated ? r("unknown", `Not in the first ${list.items.length} of ${list.count} entries read.`) : r(false);
		}
		case "ip": {
			if (!identity.ip) return r("unknown", "No IP entered.");
			return r(ipMatches(identity.ip, val.ip as string));
		}
		case "ip_list": {
			if (!identity.ip) return r("unknown", "No IP entered.");
			const list = ctx.lists[val.id as string];
			if (!list || list.error) return r("unknown", "This list could not be read.");
			const hit = anyOf(list.items.map((range) => ipMatches(identity.ip as string, range)));
			return hit === false && list.items_truncated ? r("unknown", "Only part of this list was read.") : r(hit);
		}
		case "geo":
			return identity.country ? r(lower(identity.country) === lower(val.country_code as string)) : r("unknown", "No country entered.");
		case "login_method":
			if (!user) return r(false, "A service token does not log in.");
			return identity.idpId ? r(identity.idpId === val.id) : r("unknown", "No identity provider chosen.");
		case "auth_method":
			if (!user) return r(false);
			return identity.authMethod ? r(lower(identity.authMethod) === lower(val.auth_method as string)) : r("unknown", "No auth method entered.");
		case "any_valid_service_token":
			return r(!user && !!identity.serviceTokenId, user ? "A browser login presents no service token." : undefined);
		case "service_token":
			if (user) return r(false, "A browser login presents no service token.");
			return identity.serviceTokenId ? r(identity.serviceTokenId === val.token_id) : r("unknown", "No token id entered.");
		case "azureAD":
		case "okta":
		case "gsuite":
		case "github-organization": {
			if (!user) return r(false);
			const result = hasGroup(identity, val.id as string, val.name as string, val.email as string, val.team as string);
			return r(result, result === "unknown" ? "No identity-provider groups entered." : undefined);
		}
		case "saml": {
			if (!user) return r(false);
			const pair = `${val.attribute_name}=${val.attribute_value}`;
			const result = hasGroup(identity, pair, val.attribute_value as string);
			return r(result, result === "unknown" ? "No SAML attributes entered." : undefined);
		}
		case "group": {
			const id = val.id as string;
			const group = ctx.groups[id];
			if (!group) return r("unknown", "This Access group could not be read.");
			if (visiting.has(id)) return r("unknown", "Groups reference each other in a cycle.");
			const next = new Set(visiting).add(id);
			return r(combine(group, identity, ctx, next).match);
		}
		default:
			// certificate, common_name, device_posture, external_evaluation, auth_context, …:
			// properties of the device or the request that a form cannot stand in for.
			return r("unknown", "Depends on the device or request — not modelled here.");
	}
}

function combine(
	rules: { include?: unknown[]; require?: unknown[]; exclude?: unknown[] },
	identity: TestIdentity,
	ctx: EvalContext,
	visiting: Set<string>,
): { match: Tri; include: RuleResult[]; require: RuleResult[]; exclude: RuleResult[] } {
	const include = (rules.include ?? []).map((rule) => evalRule(rule, identity, ctx, visiting));
	const require = (rules.require ?? []).map((rule) => evalRule(rule, identity, ctx, visiting));
	const exclude = (rules.exclude ?? []).map((rule) => evalRule(rule, identity, ctx, visiting));
	const match = allOf([anyOf(include.map((x) => x.result)), allOf(require.map((x) => x.result)), not(anyOf(exclude.map((x) => x.result)))]);
	return { match, include, require, exclude };
}

// ---------------------------------------------------------------------------
// Application

const FIRST_PASS = new Set(["bypass", "non_identity"]);

export function evaluateAccess(app: CfApp, identity: TestIdentity, ctx: EvalContext): AccessTestResult {
	const trace: PolicyTrace[] = (app.policies ?? [])
		.map((raw) => resolvePolicy(raw, ctx.reusable))
		.map((policy) => ({
			policy,
			decision: policy.decision ?? "",
			precedence: typeof policy.precedence === "number" ? policy.precedence : Number.MAX_SAFE_INTEGER,
			...combine(policy, identity, ctx, new Set()),
		}))
		.sort((a, b) => a.precedence - b.precedence);

	const ordered = [...trace.filter((t) => FIRST_PASS.has(t.decision)), ...trace.filter((t) => !FIRST_PASS.has(t.decision))];
	const undecided: PolicyTrace[] = [];
	let idpChecked = false;

	for (const t of ordered) {
		// Past the bypass/service pass, a user must first be able to log in at all.
		if (!idpChecked && !FIRST_PASS.has(t.decision)) {
			idpChecked = true;
			if (identity.mode === "user" && app.allowed_idps?.length && identity.idpId && !app.allowed_idps.includes(identity.idpId)) {
				return { verdict: undecided.length ? "depends" : "idp-not-allowed", undecided, trace };
			}
		}
		if (t.match === "unknown") {
			undecided.push(t);
			continue;
		}
		if (t.match !== true) continue;
		const verdict: Verdict =
			t.decision === "bypass" ? "bypass" : t.decision === "non_identity" ? "service" : t.decision === "deny" ? "blocked" : "allowed";
		return { verdict: undecided.length ? "depends" : verdict, decidedBy: t, undecided, trace };
	}
	return { verdict: undecided.length ? "depends" : "denied-default", undecided, trace };
}

export function buildEvalContext(groups: CfGroup[], lists: CfList[], idps: CfIdp[], reusable: Record<string, CfPolicy>): EvalContext {
	return {
		groups: Object.fromEntries(groups.map((g) => [g.id, g])),
		lists: Object.fromEntries(lists.map((l) => [l.id, l])),
		idps: Object.fromEntries(idps.map((i) => [i.id, i])),
		reusable,
	};
}

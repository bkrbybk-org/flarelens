/**
 * Gateway Policies: the account's Gateway rules, grouped and ordered the way Cloudflare actually
 * enforces them, with a small set of narrow, defensible findings.
 *
 * Order of enforcement — https://developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/
 *
 *   "Gateway evaluates policies in the following order: DNS policies with pre-resolution
 *   selectors, Resolver policies (Enterprise only), DNS policies with post-resolution selectors,
 *   Egress policies (Enterprise only), Network policies, HTTP policies." For HTTP/3 traffic the
 *   sequence simplifies to DNS -> Network -> HTTP.
 *
 *   Within DNS: "in order of DNS resolution, then in order of precedence" — a policy whose
 *   selector is evaluated before resolution takes precedence over one evaluated after, regardless
 *   of the `precedence` field. Within Network: precedence order, no further sequencing. Within
 *   HTTP: "Do Not Inspect policies are evaluated before any Allow or Block policies, regardless of
 *   their position in the policy list" — then Isolate, then Allow/Block/Do Not Scan, then request
 *   body inspection (DLP, antivirus, sandboxing).
 *
 *   First-match principle, stated for DNS and repeated for HTTP/Network Block: "Once traffic
 *   matches an Allow or Block policy, evaluation stops and no subsequent policies can override
 *   the decision." Do Not Inspect is stronger still — a matching site "is automatically allowed
 *   through Gateway and bypasses all other HTTP policies."
 *
 * What this cannot see, honestly:
 *
 *   - The account's `rules` list gives every rule a single `precedence` and no resolved/
 *     pre-resolution split. Distinguishing a DNS policy's pre- vs post-resolution selectors would
 *     mean parsing which wirefilter fields its `traffic` expression touches (`dns.fqdn` vs
 *     `dns.resolved_ip`, for one) — this module does not attempt that, and the UI says so rather
 *     than claiming an ordering within the DNS stage it cannot verify.
 *   - Egress and Resolver policies are Enterprise-only stages the fetched `filters` never carry
 *     here (the live account has none); they are named in the stage list for completeness but
 *     never populated.
 *   - "Shadowed" is claimed only for the narrowest case Cloudflare's docs support outright: an
 *     earlier, enabled, terminating rule of the *same* type whose traffic/identity/device_posture
 *     are all empty or the literal wirefilter `true`. Any other overlap between two expressions is
 *     a claim this module refuses to make, same as the WAF evaluation-order view.
 */

export type GwFilterType = "dns" | "http" | "l4" | "dns_resolver";

export interface GwRuleSettings {
	untrusted_cert?: { action?: string } | null;
	[key: string]: unknown;
}

/** One rule as Cloudflare's `GET /accounts/{account_id}/gateway/rules` returns it. */
export interface CfGatewayRule {
	id: string;
	name: string;
	description?: string;
	precedence: number;
	enabled: boolean;
	action: string;
	filters: GwFilterType[];
	traffic?: string;
	identity?: string;
	device_posture?: string;
	rule_settings?: GwRuleSettings;
	created_at?: string;
	updated_at?: string;
	deleted_at?: string | null;
	version?: number;
	sharable?: boolean;
}

/** Normalised rule this module works with everywhere past the initial read. */
export interface GwRule {
	id: string;
	name: string;
	description: string;
	precedence: number;
	enabled: boolean;
	action: string;
	/** The rule's primary filter type — the first of `filters`, which is always length 1 in
	 * practice on the live account (19 http / 6 dns / 6 l4 / 2 dns_resolver, no rule with two). */
	filterType: GwFilterType | null;
	filters: GwFilterType[];
	traffic: string;
	identity: string;
	devicePosture: string;
	untrustedCertAction: string | null;
	updatedAt: string | null;
}

export function normaliseGatewayRule(raw: CfGatewayRule): GwRule {
	return {
		id: raw.id,
		name: raw.name || raw.id,
		description: raw.description || "",
		precedence: typeof raw.precedence === "number" ? raw.precedence : Number.MAX_SAFE_INTEGER,
		enabled: !!raw.enabled,
		action: raw.action || "",
		filterType: raw.filters?.[0] ?? null,
		filters: raw.filters || [],
		traffic: raw.traffic || "",
		identity: raw.identity || "",
		devicePosture: raw.device_posture || "",
		untrustedCertAction: raw.rule_settings?.untrusted_cert?.action ?? null,
		updatedAt: raw.updated_at || null,
	};
}

// ---------------------------------------------------------------------------
// Enforcement stages

export interface GwStage {
	id: GwFilterType;
	label: string;
	/** What this stage runs on, one line, for the page's own copy. */
	detail: string;
}

/**
 * The documented order, collapsed to the four filter types this account's rules actually carry.
 * Egress and the pre-/post-resolution split within DNS are real stages in Cloudflare's model but
 * are not represented here — see the module comment for why.
 */
export const GATEWAY_STAGES: GwStage[] = [
	{ id: "dns_resolver", label: "DNS resolver policies", detail: "Enterprise-only re-resolution step, evaluated before DNS policies with post-resolution selectors." },
	{ id: "dns", label: "DNS policies", detail: "Evaluated at resolution time. Cloudflare orders pre- vs post-resolution selectors before precedence; this view cannot tell the two apart and shows one precedence-ordered list." },
	{ id: "l4", label: "Network (L4) policies", detail: "Evaluated on proxied network traffic, after DNS resolution and before HTTP." },
	{ id: "http", label: "HTTP policies", detail: "Evaluated on proxied HTTP(S) traffic. Do Not Inspect rules run first regardless of precedence, then Isolate, then Allow/Block/Do Not Scan, then body inspection." },
];

/**
 * Actions that end evaluation for a request within their own type, per the docs cited above.
 *
 * DNS: Allow, Block, Override, Safe Search and YouTube Restricted all produce a final answer for
 * the query (first-match principle) — grouped here as terminating for the same reason the WAF
 * view treats a matching Block/Challenge as terminating.
 * L4/HTTP: Allow and Block terminate under first-match. HTTP `off` (Do Not Inspect) is documented
 * as bypassing "all other HTTP policies" outright. `isolate` routes the request through Browser
 * Isolation instead of ordinary HTTP inspection, so nothing later in the HTTP list still applies
 * to it in the ordinary sense.
 */
const TERMINATING_ACTIONS: Record<GwFilterType, Set<string>> = {
	dns_resolver: new Set(["block", "resolve"]),
	dns: new Set(["allow", "block", "override", "safesearch", "ytrestricted"]),
	l4: new Set(["allow", "block"]),
	http: new Set(["off", "isolate", "allow", "block"]),
};

function isMatchAll(expr: string): boolean {
	return expr.trim() === "" || expr.trim() === "true";
}

/** A rule that matches every request it could possibly see: empty/`true` on all three conditions. */
function isUnconditional(rule: GwRule): boolean {
	return isMatchAll(rule.traffic) && isMatchAll(rule.identity) && isMatchAll(rule.devicePosture);
}

export interface GwStageView {
	stage: GwStage;
	/** Rules of this type, precedence ascending (Cloudflare's own within-type order for L4/HTTP;
	 * see the stage's `detail` for what DNS's ordering claim does not cover). */
	rules: GwOrderedRule[];
}

export interface GwOrderedRule {
	rule: GwRule;
	/** 1-based position within its stage, by ascending precedence. */
	position: number;
	terminating: boolean;
	/** Set when an earlier, enabled, terminating, unconditional rule of the same type runs first. */
	shadowedBy?: { id: string; name: string };
}

export function buildStageViews(rules: GwRule[]): GwStageView[] {
	const byType = new Map<GwFilterType, GwRule[]>();
	for (const rule of rules) {
		if (!rule.filterType) continue;
		const list = byType.get(rule.filterType) ?? [];
		list.push(rule);
		byType.set(rule.filterType, list);
	}
	for (const list of byType.values()) {
		list.sort((a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id));
	}

	return GATEWAY_STAGES.map((stage) => {
		const list = byType.get(stage.id) ?? [];
		let stopper: { id: string; name: string } | null = null;
		const ordered: GwOrderedRule[] = list.map((rule, i) => {
			const terminating = rule.enabled && TERMINATING_ACTIONS[stage.id].has(rule.action);
			const item: GwOrderedRule = { rule, position: i + 1, terminating };
			if (stopper) item.shadowedBy = stopper;
			if (!stopper && terminating && isUnconditional(rule)) {
				stopper = { id: rule.id, name: rule.name };
			}
			return item;
		});
		return { stage, rules: ordered };
	});
}

// ---------------------------------------------------------------------------
// Findings

export type GwSeverity = "high" | "medium" | "low" | "info";

/**
 * Severity table (documented here rather than scattered across the code that raises each one):
 *
 *   | Finding                                             | Severity |
 *   |------------------------------------------------------|----------|
 *   | Disabled rule                                         | low      |
 *   | Rule shadowed by an earlier terminating match-all rule| medium   |
 *   | HTTP `allow` with no identity condition                | medium   |
 *   | HTTP `off` (Do Not Inspect)                            | low      |
 *   | `rule_settings.untrusted_cert.action === "pass_through"`| medium  |
 *   | A stage with zero rules                                | info     |
 */
export interface GwFinding {
	severity: GwSeverity;
	ruleId: string | null;
	ruleName: string | null;
	filterType: GwFilterType | null;
	title: string;
	detail: string;
}

export function computeFindings(rules: GwRule[], stageViews: GwStageView[]): GwFinding[] {
	const findings: GwFinding[] = [];

	for (const rule of rules) {
		if (!rule.enabled) {
			findings.push({
				severity: "low",
				ruleId: rule.id,
				ruleName: rule.name,
				filterType: rule.filterType,
				title: "Rule disabled",
				detail: `"${rule.name}" is disabled and matches no traffic.`,
			});
		}
	}

	for (const view of stageViews) {
		for (const item of view.rules) {
			if (item.shadowedBy && item.rule.enabled) {
				findings.push({
					severity: "medium",
					ruleId: item.rule.id,
					ruleName: item.rule.name,
					filterType: view.stage.id,
					title: "Rule never runs",
					detail: `"${item.shadowedBy.name}" is an earlier, enabled ${view.stage.label} rule that matches every request and terminates evaluation before "${item.rule.name}" is reached.`,
				});
			}
		}
	}

	for (const rule of rules) {
		if (rule.filterType === "http" && rule.enabled && rule.action === "allow" && isMatchAll(rule.identity)) {
			findings.push({
				severity: "medium",
				ruleId: rule.id,
				ruleName: rule.name,
				filterType: "http",
				title: "Allow rule with no identity condition",
				detail: `"${rule.name}" allows anything matching its traffic condition through, for any user — it carries no identity condition.`,
			});
		}
		if (rule.filterType === "http" && rule.enabled && rule.action === "off") {
			findings.push({
				severity: "low",
				ruleId: rule.id,
				ruleName: rule.name,
				filterType: "http",
				title: "Do Not Inspect rule",
				detail: `"${rule.name}" bypasses TLS inspection (and every other HTTP policy) for traffic matching its condition.`,
			});
		}
		if (rule.filterType === "http" && rule.enabled && rule.untrustedCertAction === "pass_through") {
			findings.push({
				severity: "medium",
				ruleId: rule.id,
				ruleName: rule.name,
				filterType: "http",
				title: "Untrusted certificates passed through",
				detail: `"${rule.name}" is configured to pass through connections to origins with an untrusted certificate, rather than blocking them.`,
			});
		}
	}

	for (const view of stageViews) {
		if (view.rules.length === 0) {
			findings.push({
				severity: "info",
				ruleId: null,
				ruleName: null,
				filterType: view.stage.id,
				title: "No rules of this type",
				detail: `The account has no ${view.stage.label.toLowerCase()}.`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Report assembly

export interface GwReport {
	rules: GwRule[];
	stages: GwStageView[];
	findings: GwFinding[];
	totals: {
		rules: number;
		enabled: number;
		disabled: number;
		byType: Record<GwFilterType, number>;
	};
}

export function buildGatewayPoliciesReport(rawRules: CfGatewayRule[]): GwReport {
	const rules = rawRules.map(normaliseGatewayRule);
	const stages = buildStageViews(rules);
	const findings = computeFindings(rules, stages);

	const byType: Record<GwFilterType, number> = { dns: 0, http: 0, l4: 0, dns_resolver: 0 };
	let enabled = 0;
	for (const rule of rules) {
		if (rule.enabled) enabled++;
		if (rule.filterType) byType[rule.filterType]++;
	}

	return {
		rules,
		stages,
		findings,
		totals: { rules: rules.length, enabled, disabled: rules.length - enabled, byType },
	};
}

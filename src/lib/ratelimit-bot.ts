/**
 * Rate Limiting & Bots: configuration review, zone-scoped with an account-wide roll-up.
 *
 * Two independent halves, same rule as everywhere else in this app — a check that could not run
 * is reported as unknown, with its reason, never folded into "zero" or "off":
 *
 *   Rate limiting   The `http_ratelimit` phase entrypoint ruleset, per zone and per account. A
 *                    404 on the entrypoint means the zone/account genuinely has no rate-limit
 *                    rules configured (a real zero); a 403 means the bound token cannot read this
 *                    scope's ruleset (unknown, not zero). Those two must never render the same.
 *   Bot management   `GET /zones/{id}/bot_management` per zone. Which keys the response carries
 *                    is itself the signal for which plan tier is active — see inferPlanTier below
 *                    — so unknown keys are passed through untouched rather than dropped, in case
 *                    a future plan tier adds one this file does not yet know about.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const RATE_LIMIT_PHASE = "http_ratelimit";

export class RatelimitBotError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "RatelimitBotError";
	}
}

// ---------------------------------------------------------------------------
// Fetch plumbing (same conventions as waf-meta.ts: cfFetch throws, tryCfFetch swallows)

interface CfBody<T = unknown> {
	success?: boolean;
	errors?: { message: string; code?: number }[];
	result?: T;
}

async function cfFetch<T = unknown>(url: string, token: string): Promise<{ status: number; body: CfBody<T> }> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});
	let body: CfBody<T>;
	try {
		body = await response.json();
	} catch {
		body = { success: false, errors: [{ message: `Cloudflare API returned non-JSON response (${response.status})` }] };
	}
	return { status: response.status, body };
}

/** Why an entrypoint or settings read could not be used, distinguishing "empty" from "refused". */
function unavailableReason(status: number, message: string | undefined): string {
	if (status === 403 || status === 401) {
		return message ? `Not checked — missing permission: ${message}` : "Not checked — missing permission.";
	}
	return message || `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Rate limiting rules

export interface RateLimitParams {
	characteristics?: string[];
	period?: number;
	requestsPerPeriod?: number;
	mitigationTimeout?: number;
	countingExpression?: string;
	requestsToOrigin?: boolean;
	scorePerPeriod?: number;
	scoreResponseHeaderName?: string;
}

export interface RateLimitRule {
	ruleId: string;
	description: string;
	enabled: boolean;
	action: string;
	expression: string;
	ratelimit: RateLimitParams | null;
}

export interface RateLimitScope {
	scope: "zone" | "account";
	zoneId?: string;
	zoneName?: string;
	/** "ok" covers both "rules configured" and the genuine-zero 404 case; "unknown" is a refusal. */
	status: "ok" | "unknown";
	reason?: string;
	rules: RateLimitRule[];
}

interface CfRatelimitRule {
	id?: string;
	description?: string;
	enabled?: boolean;
	action?: string;
	expression?: string;
	ratelimit?: {
		characteristics?: string[];
		period?: number;
		requests_per_period?: number;
		mitigation_timeout?: number;
		counting_expression?: string;
		requests_to_origin?: boolean;
		score_per_period?: number;
		score_response_header_name?: string;
	};
}

interface CfRuleset {
	rules?: CfRatelimitRule[];
}

function toRateLimitParams(raw: CfRatelimitRule["ratelimit"]): RateLimitParams | null {
	if (!raw) return null;
	const out: RateLimitParams = {};
	if (raw.characteristics) out.characteristics = raw.characteristics;
	if (typeof raw.period === "number") out.period = raw.period;
	if (typeof raw.requests_per_period === "number") out.requestsPerPeriod = raw.requests_per_period;
	if (typeof raw.mitigation_timeout === "number") out.mitigationTimeout = raw.mitigation_timeout;
	if (typeof raw.counting_expression === "string") out.countingExpression = raw.counting_expression;
	if (typeof raw.requests_to_origin === "boolean") out.requestsToOrigin = raw.requests_to_origin;
	if (typeof raw.score_per_period === "number") out.scorePerPeriod = raw.score_per_period;
	if (typeof raw.score_response_header_name === "string") out.scoreResponseHeaderName = raw.score_response_header_name;
	return out;
}

function toRateLimitRule(rule: CfRatelimitRule): RateLimitRule {
	return {
		ruleId: rule.id || "",
		description: rule.description || "",
		enabled: rule.enabled !== false,
		action: rule.action || "",
		expression: rule.expression || "",
		ratelimit: toRateLimitParams(rule.ratelimit),
	};
}

/**
 * One scope's rate-limit rules (zone or account entrypoint ruleset).
 *
 * A 404 here is Cloudflare's documented way of saying "no ruleset exists at this phase entrypoint
 * yet" — i.e. no rate-limit rules configured. That is a real, checked zero, reported as
 * `status: "ok"` with an empty rule list. A 403/401 means the token cannot read the ruleset at
 * all, which is a different fact and must not collapse into the same zero.
 */
export async function fetchRateLimitScope(
	kind: "zones" | "accounts",
	id: string,
	name: string | undefined,
	token: string,
): Promise<RateLimitScope> {
	const scope: "zone" | "account" = kind === "zones" ? "zone" : "account";
	const base: Omit<RateLimitScope, "status" | "rules" | "reason"> =
		scope === "zone" ? { scope, zoneId: id, zoneName: name } : { scope };

	const { status, body } = await cfFetch<CfRuleset>(
		`${CF_API_BASE}/${kind}/${encodeURIComponent(id)}/rulesets/phases/${RATE_LIMIT_PHASE}/entrypoint`,
		token,
	);

	if (status === 404) {
		return { ...base, status: "ok", rules: [] };
	}
	if (status !== 200 || body.success === false) {
		return { ...base, status: "unknown", reason: unavailableReason(status, body.errors?.[0]?.message), rules: [] };
	}
	const rules = (body.result?.rules || []).map(toRateLimitRule);
	return { ...base, status: "ok", rules };
}

// ---------------------------------------------------------------------------
// Bot management

/**
 * Which plan tier is active, inferred from which keys the response carries.
 *
 * Cloudflare does not return a plan-tier field directly on `bot_management` — the shape of the
 * response itself is the signal. `fight_mode` alone (a boolean toggle, nothing else) is the free
 * Bot Fight Mode tier. The `sbfm_*` action fields appear once Super Bot Fight Mode is available
 * (Pro/Business). `using_latest_model`, `suppress_session_score` and `auto_update_model` are
 * Enterprise Bot Management fields that do not exist on the lower tiers at all. This inference is
 * a best-effort reading of the documented fields, not a Cloudflare-confirmed mapping — flagged as
 * unverified in this feature's rollout notes.
 */
export type BotPlanTier = "enterprise" | "super_bot_fight_mode" | "bot_fight_mode" | "unknown";

const ENTERPRISE_KEYS = ["using_latest_model", "suppress_session_score", "auto_update_model", "ai_bots_protection"];
const SBFM_KEYS = [
	"sbfm_definitely_automated",
	"sbfm_likely_automated",
	"sbfm_verified_bots",
	"sbfm_static_resource_protection",
];

export function inferPlanTier(settings: Record<string, unknown>): BotPlanTier {
	if (ENTERPRISE_KEYS.some((k) => k in settings)) return "enterprise";
	if (SBFM_KEYS.some((k) => k in settings)) return "super_bot_fight_mode";
	if ("fight_mode" in settings) return "bot_fight_mode";
	return "unknown";
}

export interface BotManagementZone {
	zoneId: string;
	zoneName: string;
	status: "ok" | "unknown";
	reason?: string;
	planTier: BotPlanTier;
	/** Every field Cloudflare returned, passed through untouched — see inferPlanTier. */
	settings: Record<string, unknown>;
}

export async function fetchBotManagement(zoneId: string, zoneName: string, token: string): Promise<BotManagementZone> {
	const { status, body } = await cfFetch<Record<string, unknown>>(`${CF_API_BASE}/zones/${encodeURIComponent(zoneId)}/bot_management`, token);
	if (status !== 200 || body.success === false) {
		return {
			zoneId,
			zoneName,
			status: "unknown",
			reason: unavailableReason(status, body.errors?.[0]?.message),
			planTier: "unknown",
			settings: {},
		};
	}
	const settings = body.result || {};
	return { zoneId, zoneName, status: "ok", planTier: inferPlanTier(settings), settings };
}

// ---------------------------------------------------------------------------
// Findings

export type FindingSeverity = "high" | "medium" | "low" | "info";

export interface Finding {
	severity: FindingSeverity;
	zoneId?: string;
	zoneName?: string;
	title: string;
	detail: string;
}

/**
 * Findings computed from what was actually read. Nothing here fires for a scope whose check came
 * back `unknown` — an unreadable ruleset or an unreadable bot_management response contributes to
 * the unknown-checks count instead, never to a finding either way.
 */
export function computeFindings(rateLimitScopes: RateLimitScope[], botZones: BotManagementZone[]): Finding[] {
	const findings: Finding[] = [];

	for (const scope of rateLimitScopes) {
		if (scope.status !== "ok") continue;
		if (scope.scope === "zone" && scope.rules.length === 0) {
			findings.push({
				severity: "medium",
				zoneId: scope.zoneId,
				zoneName: scope.zoneName,
				title: "No rate-limit rules configured",
				detail: "This zone has no rules at the http_ratelimit phase entrypoint.",
			});
		}
		for (const rule of scope.rules) {
			const label = rule.description || rule.ruleId || "(unnamed rule)";
			if (!rule.enabled) {
				findings.push({
					severity: "low",
					zoneId: scope.zoneId,
					zoneName: scope.zoneName,
					title: "Rate-limit rule disabled",
					detail: `"${label}" is disabled and enforces nothing.`,
				});
			} else if (rule.action === "log") {
				findings.push({
					severity: "medium",
					zoneId: scope.zoneId,
					zoneName: scope.zoneName,
					title: "Rate-limit rule only logs",
					detail: `"${label}" takes action "log" — traffic over the threshold is recorded but never mitigated.`,
				});
			}
		}
	}

	for (const zone of botZones) {
		if (zone.status !== "ok") continue;
		const s = zone.settings;
		const fightMode = s.fight_mode === true;
		const anySbfmAction = SBFM_KEYS.some((k) => typeof s[k] === "string" && s[k] !== "off");
		if (!fightMode && !anySbfmAction) {
			findings.push({
				severity: "high",
				zoneId: zone.zoneId,
				zoneName: zone.zoneName,
				title: "Bot protection is off",
				detail: "Neither Bot Fight Mode nor a Super Bot Fight Mode action is enabled for this zone.",
			});
		}
		if (s.enable_js === false) {
			findings.push({
				severity: "low",
				zoneId: zone.zoneId,
				zoneName: zone.zoneName,
				title: "JS detection disabled",
				detail: "enable_js is off, weakening this zone's bot detection signal.",
			});
		}
		if (typeof s.ai_bots_protection === "string" && s.ai_bots_protection !== "block") {
			findings.push({
				severity: "info",
				zoneId: zone.zoneId,
				zoneName: zone.zoneName,
				title: "AI bots not blocked",
				detail: `ai_bots_protection is "${s.ai_bots_protection}", not "block".`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Report assembly

export interface BbZone {
	id: string;
	name: string;
}

export interface RatelimitBotResult {
	rateLimit: RateLimitScope[];
	botManagement: BotManagementZone[];
	findings: Finding[];
	totals: {
		zonesChecked: number;
		rateLimitRules: number;
		zonesWithNoRateLimitRules: number;
		botProtectionOn: number;
		botProtectionOff: number;
		botProtectionUnknown: number;
	};
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Workers allow ~6 simultaneous connections per host — same budget as pqc.ts and zone-health.ts. */
const CONCURRENCY = 5;

/**
 * One account's Rate Limits & Bots report, fetched fresh from Cloudflare.
 *
 * Always fetches the account-wide rate-limit entrypoint once, plus each zone's own entrypoint and
 * bot_management — narrowed to a single zone by the caller pre-filtering `zones` when a zone is
 * selected. Zone reads are bounded-concurrency; the account read is a single extra call.
 */
export async function fetchRatelimitBotReport(accountId: string, zones: BbZone[], token: string): Promise<RatelimitBotResult> {
	const [accountScope, zoneResults] = await Promise.all([
		fetchRateLimitScope("accounts", accountId, undefined, token),
		mapWithConcurrency(zones, CONCURRENCY, async (zone) => {
			const [rateLimit, bot] = await Promise.all([
				fetchRateLimitScope("zones", zone.id, zone.name, token),
				fetchBotManagement(zone.id, zone.name, token),
			]);
			return { rateLimit, bot };
		}),
	]);

	const rateLimit: RateLimitScope[] = [accountScope, ...zoneResults.map((r) => r.rateLimit)];
	const botManagement: BotManagementZone[] = zoneResults.map((r) => r.bot);
	const findings = computeFindings(rateLimit, botManagement);

	const rateLimitRules = rateLimit.reduce((sum, s) => sum + (s.status === "ok" ? s.rules.length : 0), 0);
	const zonesWithNoRateLimitRules = zoneResults.filter((r) => r.rateLimit.status === "ok" && r.rateLimit.rules.length === 0).length;
	const botProtectionOn = botManagement.filter((z) => {
		if (z.status !== "ok") return false;
		return z.settings.fight_mode === true || SBFM_KEYS.some((k) => typeof z.settings[k] === "string" && z.settings[k] !== "off");
	}).length;
	const botProtectionUnknown = botManagement.filter((z) => z.status !== "ok").length;
	const botProtectionOff = botManagement.length - botProtectionOn - botProtectionUnknown;

	return {
		rateLimit,
		botManagement,
		findings,
		totals: {
			zonesChecked: zones.length,
			rateLimitRules,
			zonesWithNoRateLimitRules,
			botProtectionOn,
			botProtectionOff,
			botProtectionUnknown,
		},
	};
}

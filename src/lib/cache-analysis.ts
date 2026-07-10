/**
 * Ported from cf-cache-analyzer src/index.ts (analysis half).
 *
 * DATA-HONESTY MODEL (preserved from the original):
 *  - Full cacheStatus enum preserved end-to-end; hit ratio uses
 *    Cloudflare-consistent "served from cache" semantics
 *    (hit + stale + updating + revalidated).
 *  - Traffic matching no path-evaluable rule is surfaced as an explicit
 *    "unattributed" block, never redistributed with synthetic weights.
 *  - GraphQL failures are classified (permissions / retention / other) and
 *    reported; mock fallback data is always labeled as such.
 *
 * Auth adapted to this app's model: Bearer token only (legacy X-Auth-Key
 * support dropped).
 */
// Single-source expression evaluator lives with the web app (client URL tester
// uses it too); the worker bundles it from there.
import { compileExpression, compileTriState, UnsupportedExpressionError, type RequestFacts } from "../../web/src/lib/expr";
import {
	isRecord,
	type CfEnvelope,
	type CfEnvironment,
	type CfEnvironmentsResult,
	type CfRawRule,
	type CfRuleset,
	type CfZone,
	type GqlError,
	type GqlGroup,
	type GqlResponse,
} from "./cache-cf-types";

const CF_API = "https://api.cloudflare.com/client/v4";

export type CacheCredentials = { token: string; zoneId: string };

/* ------------------------------------------------------------------ */
/* Cache-status model                                                  */
/* ------------------------------------------------------------------ */

type StatusCounts = Record<string, number>;

const KNOWN_STATUSES = new Set(["hit", "miss", "expired", "stale", "updating", "revalidated", "dynamic", "bypass"]);
/** Served from Cloudflare's cache without a full origin fetch. */
const SERVED_STATUSES = new Set(["hit", "stale", "updating", "revalidated"]);
/** Cacheable but the origin was involved. */
const ORIGIN_STATUSES = new Set(["miss", "expired"]);

function canonStatus(raw: string): string {
	const s = raw.toLowerCase();
	if (KNOWN_STATUSES.has(s)) return s;
	if (s === "deferred") return "dynamic";
	return "other";
}

function addStatus(counts: StatusCounts, status: string, n: number): void {
	if (n <= 0) return;
	counts[status] = (counts[status] ?? 0) + n;
}

export type RuleAnalytics = {
	statuses: StatusCounts;
	hits: number;
	misses: number;
	bypass: number;
	hitRatio: number;
};

export function summarize(statuses: StatusCounts): RuleAnalytics {
	let hits = 0;
	let misses = 0;
	let bypass = 0;
	for (const [status, n] of Object.entries(statuses)) {
		if (SERVED_STATUSES.has(status)) hits += n;
		else if (ORIGIN_STATUSES.has(status)) misses += n;
		else bypass += n;
	}
	const total = hits + misses + bypass;
	const hitRatio = total === 0 ? 0 : Math.round((hits / total) * 1000) / 10;
	return { statuses, hits, misses, bypass, hitRatio };
}

const EMPTY_ANALYTICS: RuleAnalytics = { statuses: {}, hits: 0, misses: 0, bypass: 0, hitRatio: 0 };

export type RuleSettings = {
	cache?: boolean;
	edgeTtl?: string;
	browserTtl?: string;
	customCacheKey?: boolean;
	serveStale?: boolean;
	respectStrongEtags?: boolean;
};

type Attribution = "measured" | "unattributable" | "mock";

export type RuleShell = {
	id: string;
	description: string;
	expression: string;
	enabled: boolean;
	action: string;
	settings: RuleSettings;
};

export type TopUrl = { url: string; requests: number; hitRatio: number };

export type CacheRule = RuleShell & {
	attribution: Attribution;
	attributionNote?: string;
	analytics: RuleAnalytics;
	topUrls?: TopUrl[];
};

export type UnattributedBlock = {
	analytics: RuleAnalytics;
	topUrls: TopUrl[];
	mixed: boolean;
};

/* ------------------------------------------------------------------ */
/* Cloudflare REST plumbing                                            */
/* ------------------------------------------------------------------ */

function authHeaders(creds: Pick<CacheCredentials, "token">): Record<string, string> {
	return { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" };
}

async function cfFetch<T>(path: string, creds: Pick<CacheCredentials, "token">): Promise<{ status: number; json: CfEnvelope<T> | null }> {
	const res = await fetch(`${CF_API}${path}`, { headers: authHeaders(creds) });
	let json: CfEnvelope<T> | null = null;
	try {
		json = (await res.json()) as CfEnvelope<T>;
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

function cfErrorMessages(json: CfEnvelope | null): string {
	const parts: string[] = [];
	for (const e of json?.errors ?? []) {
		if (!e?.message) continue;
		const suffix = e.code ? ` (code ${e.code})` : "";
		parts.push(`${e.message}${suffix}`);
	}
	return parts.join("; ") || "Unknown Cloudflare API error";
}

const AUTH_ERROR_CODES = new Set([6003, 9109, 10000, 6111]);

function isAuthFailure(status: number, json: CfEnvelope | null): boolean {
	if (status === 401 || status === 403) return true;
	return (json?.errors ?? []).some((e) => AUTH_ERROR_CODES.has(Number(e?.code)));
}

/* ------------------------------------------------------------------ */
/* Deterministic mock generators (explicitly labeled in the UI)        */
/* ------------------------------------------------------------------ */

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function mockStatuses(rand: () => number, total: number): StatusCounts {
	const servedShare = 0.55 + rand() * 0.4;
	const served = Math.floor(total * servedShare);
	const hit = Math.floor(served * (0.85 + rand() * 0.13));
	const revalidated = served - hit;
	const rest = total - served;
	const expired = Math.floor(rest * (0.15 + rand() * 0.25));
	const miss = Math.floor(rest * (0.3 + rand() * 0.3));
	const dynamic = Math.floor(rest * rand() * 0.3);
	const bypass = Math.max(0, rest - expired - miss - dynamic);
	const counts: StatusCounts = {};
	addStatus(counts, "hit", hit);
	addStatus(counts, "revalidated", revalidated);
	addStatus(counts, "expired", expired);
	addStatus(counts, "miss", miss);
	addStatus(counts, "dynamic", dynamic);
	addStatus(counts, "bypass", bypass);
	return counts;
}

function mockAnalytics(ruleId: string, enabled: boolean): RuleAnalytics {
	if (!enabled) return EMPTY_ANALYTICS;
	const rand = mulberry32(fnv1a(ruleId));
	const total = Math.floor(5_000 + rand() * 495_000);
	return summarize(mockStatuses(rand, total));
}

/* ------------------------------------------------------------------ */
/* GraphQL analytics                                                   */
/* ------------------------------------------------------------------ */

type GqlOk = { ok: true; groups: GqlGroup[] };
type GqlErr = { ok: false; reason: string };
type GqlResult = GqlOk | GqlErr;

function classifyGqlErrors(errors: GqlError[]): string {
	const text = errors.map((e) => `${e?.extensions?.code ?? ""} ${e?.message ?? ""}`).join(" | ").toLowerCase();
	if (text.includes("authz") || text.includes("not authorized") || text.includes("unauthorized")) {
		return "API token lacks the Zone → Analytics: Read permission";
	}
	if (text.includes("older than") || text.includes("retention") || text.includes("time range")) {
		return "requested window exceeds this plan's analytics retention";
	}
	return errors[0]?.message ?? "Cloudflare analytics API error";
}

async function queryGraphql(
	creds: CacheCredentials,
	dataset: string,
	query: string,
	variables: Record<string, string>,
): Promise<GqlResult> {
	try {
		const res = await fetch(`${CF_API}/graphql`, {
			method: "POST",
			headers: authHeaders(creds),
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) {
			if (res.status === 401 || res.status === 403) {
				return { ok: false, reason: "API token lacks the Zone → Analytics: Read permission" };
			}
			return { ok: false, reason: `Cloudflare analytics API returned HTTP ${res.status}` };
		}
		const json = (await res.json()) as GqlResponse;
		if (Array.isArray(json.errors) && json.errors.length > 0) {
			return { ok: false, reason: classifyGqlErrors(json.errors) };
		}
		const zone = json.data?.viewer?.zones?.[0];
		if (!zone) return { ok: false, reason: "zone not visible to the analytics API" };
		const groups = zone[dataset];
		// An empty result set is a REAL answer (zero traffic), not an error.
		return { ok: true, groups: Array.isArray(groups) ? groups : [] };
	} catch {
		return { ok: false, reason: "could not reach the Cloudflare analytics API" };
	}
}

function rangeVariables(creds: CacheCredentials, rangeHours: number): Record<string, string> {
	const now = new Date();
	const since = new Date(now.getTime() - rangeHours * 60 * 60 * 1000);
	return { zoneTag: creds.zoneId, since: since.toISOString(), until: now.toISOString() };
}

function estimatedRequests(g: GqlGroup): number {
	const count = Number(g.count) || 0;
	const interval = Number(g.avg?.sampleInterval) || 1;
	return Math.round(count * interval);
}

export type PathGroup = { host: string; path: string; status: string; requests: number };

export const ALLOWED_RANGES = [24, 168, 720];

async function fetchPathGroups(
	creds: CacheCredentials,
	rangeHours: number,
): Promise<{ ok: true; groups: PathGroup[] } | GqlErr> {
	const query = `query CachePaths($zoneTag: string!, $since: Time!, $until: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          limit: 2000
          orderBy: [count_DESC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          count
          avg { sampleInterval }
          dimensions { cacheStatus clientRequestPath clientRequestHTTPHost }
        }
      }
    }
  }`;
	const res = await queryGraphql(creds, "httpRequestsAdaptiveGroups", query, rangeVariables(creds, rangeHours));
	if (!res.ok) return res;
	return {
		ok: true,
		groups: res.groups.map((g) => ({
			host: String(g.dimensions?.clientRequestHTTPHost ?? ""),
			path: String(g.dimensions?.clientRequestPath ?? "/"),
			status: canonStatus(String(g.dimensions?.cacheStatus ?? "other")),
			requests: estimatedRequests(g),
		})),
	};
}

/* ---------------------------- timeseries --------------------------- */

export type TrendBucket = { t: string; statuses: StatusCounts };

type BucketPlan = { dimension: "datetimeHour" | "date"; stepMs: number };

function bucketPlan(rangeHours: number): BucketPlan {
	return rangeHours > 168
		? { dimension: "date", stepMs: 24 * 60 * 60 * 1000 }
		: { dimension: "datetimeHour", stepMs: 60 * 60 * 1000 };
}

function bucketStart(ms: number, plan: BucketPlan): number {
	return Math.floor(ms / plan.stepMs) * plan.stepMs;
}

function zeroFilledBuckets(sinceMs: number, nowMs: number, plan: BucketPlan): Map<number, TrendBucket> {
	const buckets = new Map<number, TrendBucket>();
	for (let ms = bucketStart(sinceMs, plan); ms <= nowMs; ms += plan.stepMs) {
		buckets.set(ms, { t: new Date(ms).toISOString(), statuses: {} });
	}
	return buckets;
}

function overlayGroups(groups: GqlGroup[], buckets: Map<number, TrendBucket>, plan: BucketPlan): void {
	for (const g of groups) {
		const raw = g.dimensions?.[plan.dimension];
		if (!raw) continue;
		const bucket = buckets.get(bucketStart(Date.parse(raw), plan));
		if (!bucket) continue;
		addStatus(bucket.statuses, canonStatus(String(g.dimensions?.cacheStatus ?? "other")), estimatedRequests(g));
	}
}

async function fetchTimeseries(
	creds: CacheCredentials,
	rangeHours: number,
): Promise<{ ok: true; buckets: TrendBucket[] } | GqlErr> {
	const plan = bucketPlan(rangeHours);
	const query = `query CacheTrend($zoneTag: string!, $since: Time!, $until: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          limit: 2000
          orderBy: [${plan.dimension}_ASC]
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          count
          avg { sampleInterval }
          dimensions { cacheStatus ${plan.dimension} }
        }
      }
    }
  }`;
	const res = await queryGraphql(creds, "httpRequestsAdaptiveGroups", query, rangeVariables(creds, rangeHours));
	if (!res.ok) return res;
	const nowMs = Date.now();
	const buckets = zeroFilledBuckets(nowMs - rangeHours * 60 * 60 * 1000, nowMs, plan);
	overlayGroups(res.groups, buckets, plan);
	return { ok: true, buckets: [...buckets.values()] };
}

function mockTimeseries(zoneId: string, rangeHours: number): TrendBucket[] {
	const plan = bucketPlan(rangeHours);
	const rand = mulberry32(fnv1a(`${zoneId}:${rangeHours}`));
	const base = 2_000 + rand() * 40_000;
	const out: TrendBucket[] = [];
	const nowMs = Date.now();
	const startMs = bucketStart(nowMs - rangeHours * 60 * 60 * 1000, plan);
	for (let ms = startMs; ms <= nowMs; ms += plan.stepMs) {
		const hour = new Date(ms).getUTCHours();
		const daily = 0.6 + 0.4 * Math.sin(((hour - 6) / 24) * 2 * Math.PI); // peak mid-day
		const total = Math.floor(base * daily * (0.8 + rand() * 0.4));
		out.push({ t: new Date(ms).toISOString(), statuses: mockStatuses(rand, total) });
	}
	return out;
}

/* ------------------------- exact zone totals ------------------------ */

export type ZoneTotals = { requests: number; cached: number; sampledRequests: number; coveragePct: number };

async function fetchZoneTotals(creds: CacheCredentials, rangeHours: number): Promise<{ requests: number; cached: number } | null> {
	const daily = rangeHours > 168;
	const dataset = daily ? "httpRequests1dGroups" : "httpRequests1hGroups";
	const now = new Date();
	const since = new Date(now.getTime() - rangeHours * 60 * 60 * 1000);
	const query = daily
		? `query ZoneTotals($zoneTag: string!, $since: Date!, $until: Date!) {
        viewer { zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1dGroups(limit: 1, filter: { date_geq: $since, date_leq: $until }) {
            sum { requests cachedRequests }
          }
        } }
      }`
		: `query ZoneTotals($zoneTag: string!, $since: Time!, $until: Time!) {
        viewer { zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1hGroups(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) {
            sum { requests cachedRequests }
          }
        } }
      }`;
	const variables = daily
		? { zoneTag: creds.zoneId, since: since.toISOString().slice(0, 10), until: now.toISOString().slice(0, 10) }
		: { zoneTag: creds.zoneId, since: since.toISOString(), until: now.toISOString() };
	const res = await queryGraphql(creds, dataset, query, variables);
	if (!res.ok || res.groups.length === 0) return null;
	const sum = (res.groups[0] as { sum?: { requests?: number; cachedRequests?: number } }).sum;
	const requests = Number(sum?.requests) || 0;
	if (requests <= 0) return null;
	return { requests, cached: Number(sum?.cachedRequests) || 0 };
}

/* ------------------------------------------------------------------ */
/* Insights                                                            */
/* ------------------------------------------------------------------ */

export type Insight = { severity: "warn" | "info"; message: string };
export type Health = { ratio: number; grade: string } | null;

function ruleLabel(r: CacheRule, i: number): string {
	const desc = r.description ? ` (${r.description})` : "";
	return `#${i + 1}${desc}`;
}

function normalizedExpression(r: CacheRule): string {
	return r.expression.replace(/\s+/g, " ").trim() || "true";
}

function duplicateExpressionInsights(rules: CacheRule[]): Insight[] {
	const insights: Insight[] = [];
	const seen = new Map<string, number>();
	rules.forEach((r, i) => {
		if (!r.enabled) return;
		const norm = normalizedExpression(r);
		const prev = seen.get(norm);
		if (prev !== undefined) {
			insights.push({
				severity: "warn",
				message: `Rule ${ruleLabel(rules[prev], prev)} has the same expression as ${ruleLabel(r, i)} — the later rule's settings win, making the earlier one redundant.`,
			});
		} else {
			seen.set(norm, i);
		}
	});
	return insights;
}

function catchAllInsights(rules: CacheRule[]): Insight[] {
	const last = rules[rules.length - 1];
	if (rules.length > 1 && last?.enabled && normalizedExpression(last) === "true") {
		return [{
			severity: "warn",
			message: `Rule ${ruleLabel(last, rules.length - 1)} matches all traffic and sits last — its settings override every earlier rule where they overlap.`,
		}];
	}
	return [];
}

function ruleTotal(r: CacheRule): number {
	return r.analytics.hits + r.analytics.misses + r.analytics.bypass;
}

function perRuleInsights(rules: CacheRule[], grandTotal: number): Insight[] {
	const insights: Insight[] = [];
	rules.forEach((r, i) => {
		if (!r.enabled || r.attribution !== "measured") return;
		const total = ruleTotal(r);
		if (total === 0) {
			insights.push({
				severity: "info",
				message: `Rule ${ruleLabel(r, i)} matched no sampled traffic in the selected window — the expression may target stale paths.`,
			});
		}
		if (r.settings.cache === true && total >= 1_000 && r.analytics.hitRatio < 50) {
			insights.push({
				severity: "warn",
				message: `Rule ${ruleLabel(r, i)} caches but serves only ${r.analytics.hitRatio.toFixed(1)}% of ${total.toLocaleString()} requests from cache — check the edge TTL (expired share below) and whether the cache key varies (cookies, query strings).`,
			});
		}
		if (r.settings.cache === false && grandTotal > 0 && total / grandTotal > 0.3) {
			insights.push({
				severity: "info",
				message: `Rule ${ruleLabel(r, i)} bypasses cache for ${((total / grandTotal) * 100).toFixed(0)}% of analyzed traffic — worth confirming that scope is intended.`,
			});
		}
	});
	return insights;
}

function unattributedInsights(unattributed: UnattributedBlock | null, grandTotal: number): Insight[] {
	if (!unattributed || grandTotal === 0) return [];
	const total = unattributed.analytics.hits + unattributed.analytics.misses + unattributed.analytics.bypass;
	const share = total / grandTotal;
	if (share <= 0.3) return [];
	return [{
		severity: "info",
		message: `${(share * 100).toFixed(0)}% of analyzed traffic matched no ${unattributed.mixed ? "path-evaluable " : ""}cache rule — zone default behavior applies to it (see the unattributed row below the rules).`,
	}];
}

function pausedInsights(rules: CacheRule[]): Insight[] {
	const disabled = rules.filter((r) => !r.enabled).length;
	if (disabled === 0) return [];
	const verb = disabled === 1 ? " is" : "s are";
	return [{ severity: "info", message: `${disabled} rule${verb} paused and not affecting traffic.` }];
}

const GRADE_THRESHOLDS: Array<[minRatio: number, grade: string]> = [
	[90, "A"],
	[75, "B"],
	[60, "C"],
	[40, "D"],
];

function computeHealth(rules: CacheRule[], unattributed: UnattributedBlock | null): Health {
	let hits = 0;
	let grandTotal = 0;
	for (const r of rules) {
		hits += r.analytics.hits;
		grandTotal += ruleTotal(r);
	}
	if (unattributed) {
		hits += unattributed.analytics.hits;
		grandTotal += unattributed.analytics.hits + unattributed.analytics.misses + unattributed.analytics.bypass;
	}
	if (grandTotal === 0) return null;
	const ratio = Math.round((hits / grandTotal) * 1000) / 10;
	const grade = GRADE_THRESHOLDS.find(([min]) => ratio >= min)?.[1] ?? "F";
	return { ratio, grade };
}

/**
 * Structural checks always run; traffic-derived checks and the health grade
 * only run on real analytics — never on mock data.
 */
export function computeInsights(
	rules: CacheRule[],
	analyticsSource: string,
	unattributed: UnattributedBlock | null,
): { insights: Insight[]; health: Health } {
	const structural = [
		...duplicateExpressionInsights(rules),
		...catchAllInsights(rules),
		...pausedInsights(rules),
	];
	if (analyticsSource !== "path-graphql") {
		return { insights: structural, health: null };
	}
	const unattributedTotal = unattributed
		? unattributed.analytics.hits + unattributed.analytics.misses + unattributed.analytics.bypass
		: 0;
	const grandTotal = rules.reduce((sum, r) => sum + ruleTotal(r), 0) + unattributedTotal;
	return {
		insights: [
			...structural,
			...perRuleInsights(rules, grandTotal),
			...unattributedInsights(unattributed, grandTotal),
		],
		health: computeHealth(rules, unattributed),
	};
}

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/* ------------------------------------------------------------------ */

const UNATTRIBUTED_ID = "__unattributed__";

type UrlAcc = { requests: number; served: number };
type UrlStats = Map<string, Map<string, UrlAcc>>;

function recordUrlStat(urlStats: UrlStats, ruleId: string, g: PathGroup): void {
	let perRule = urlStats.get(ruleId);
	if (!perRule) {
		perRule = new Map();
		urlStats.set(ruleId, perRule);
	}
	const url = `${g.host}${g.path}`;
	const acc = perRule.get(url) ?? { requests: 0, served: 0 };
	acc.requests += g.requests;
	if (SERVED_STATUSES.has(g.status)) acc.served += g.requests;
	perRule.set(url, acc);
}

function topUrlsFor(perRule: Map<string, UrlAcc> | undefined, limit: number): TopUrl[] {
	if (!perRule) return [];
	return [...perRule.entries()]
		.sort((a, b) => b[1].requests - a[1].requests)
		.slice(0, limit)
		.map(([url, acc]) => ({
			url,
			requests: acc.requests,
			hitRatio: acc.requests ? Math.round((acc.served / acc.requests) * 1000) / 10 : 0,
		}));
}

type Predicate = (f: RequestFacts) => boolean;

function compileRulePredicates(rules: RuleShell[]): {
	predicates: Map<string, Predicate>;
	unattributable: Map<string, string>;
} {
	const predicates = new Map<string, Predicate>();
	const unattributable = new Map<string, string>();
	for (const r of rules) {
		if (!r.enabled) continue;
		try {
			predicates.set(r.id, compileExpression(r.expression, { forAttribution: true }));
		} catch (e) {
			if (!(e instanceof UnsupportedExpressionError)) throw e;
			unattributable.set(r.id, e.message);
		}
	}
	return { predicates, unattributable };
}

function lastMatchingRule(rules: RuleShell[], predicates: Map<string, Predicate>, facts: RequestFacts): string | null {
	let winner: string | null = null;
	for (const r of rules) {
		const pred = predicates.get(r.id);
		if (!pred) continue;
		try {
			if (pred(facts)) winner = r.id; // last match wins
		} catch {
			/* treat evaluation error as no match */
		}
	}
	return winner;
}

/**
 * Attribute per-path traffic to cache rules. Cache Rules apply cumulatively
 * with later rules overriding earlier ones per setting, so each path is
 * credited to the LAST matching enabled rule.
 */
export function attributeAnalytics(
	rules: RuleShell[],
	groups: PathGroup[],
	unattributableCount: number,
): { byRule: Map<string, { analytics: RuleAnalytics; topUrls: TopUrl[] }>; unattributed: UnattributedBlock | null; hosts: string[] } {
	const { predicates } = compileRulePredicates(rules);
	const statusByRule = new Map<string, StatusCounts>();
	const urlStats: UrlStats = new Map();
	const leftover: StatusCounts = {};
	const hostTraffic = new Map<string, number>();

	for (const g of groups) {
		if (g.host) hostTraffic.set(g.host, (hostTraffic.get(g.host) ?? 0) + g.requests);
		const winner = lastMatchingRule(rules, predicates, { path: g.path, host: g.host });
		if (winner) {
			const counts = statusByRule.get(winner) ?? {};
			addStatus(counts, g.status, g.requests);
			statusByRule.set(winner, counts);
			recordUrlStat(urlStats, winner, g);
		} else {
			addStatus(leftover, g.status, g.requests);
			recordUrlStat(urlStats, UNATTRIBUTED_ID, g);
		}
	}

	const byRule = new Map<string, { analytics: RuleAnalytics; topUrls: TopUrl[] }>();
	for (const id of predicates.keys()) {
		byRule.set(id, {
			analytics: summarize(statusByRule.get(id) ?? {}),
			topUrls: topUrlsFor(urlStats.get(id), 5),
		});
	}

	const leftoverAnalytics = summarize(leftover);
	const unattributed: UnattributedBlock | null =
		leftoverAnalytics.hits + leftoverAnalytics.misses + leftoverAnalytics.bypass > 0
			? {
				analytics: leftoverAnalytics,
				topUrls: topUrlsFor(urlStats.get(UNATTRIBUTED_ID), 5),
				mixed: unattributableCount > 0,
			}
			: null;

	const hosts = [...hostTraffic.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([host]) => host);

	return { byRule, unattributed, hosts };
}

/* ------------------------------------------------------------------ */
/* Rule settings extraction                                            */
/* ------------------------------------------------------------------ */

function formatTtl(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return `${seconds}s`;
	const units: Array<[string, number]> = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
	const parts: string[] = [];
	let rest = Math.floor(seconds);
	for (const [label, size] of units) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${label}`);
			rest %= size;
			if (parts.length === 2) break;
		}
	}
	return parts.join(" ") || "0s";
}

function ttlLabel(ttl: unknown): string | undefined {
	if (!isRecord(ttl)) return undefined;
	const mode = String(ttl.mode ?? "");
	if (mode === "override_origin") {
		const secs = Number(ttl.default);
		return Number.isFinite(secs) ? formatTtl(secs) : "override";
	}
	if (mode === "respect_origin") return "respect origin";
	if (mode === "bypass_by_default") return "bypass by default";
	return undefined;
}

function extractSettings(params: unknown): RuleSettings {
	if (!isRecord(params)) return {};
	const s: RuleSettings = {};
	if (typeof params.cache === "boolean") s.cache = params.cache;
	const edge = ttlLabel(params.edge_ttl);
	if (edge) s.edgeTtl = edge;
	const browser = ttlLabel(params.browser_ttl);
	if (browser) s.browserTtl = browser;
	if (isRecord(params.cache_key)) s.customCacheKey = true;
	if (isRecord(params.serve_stale)) s.serveStale = true;
	if (typeof params.respect_strong_etags === "boolean") s.respectStrongEtags = params.respect_strong_etags;
	return s;
}

function toRuleShell(r: CfRawRule): RuleShell {
	return {
		id: String(r.id ?? ""),
		description: typeof r.description === "string" ? r.description : "",
		expression: typeof r.expression === "string" ? r.expression : "",
		enabled: r.enabled !== false,
		action: typeof r.action === "string" ? r.action : "set_cache_settings",
		settings: extractSettings(r.action_parameters),
	};
}

/* ------------------------------------------------------------------ */
/* Upstream steps                                                      */
/* ------------------------------------------------------------------ */

export type StepError = { error: string; status: 400 | 401 | 403 | 404 | 502 };

const UNREACHABLE: StepError = { error: "Could not reach the Cloudflare API. Try again.", status: 502 };

export async function fetchZoneName(creds: CacheCredentials): Promise<{ zoneName: string } | StepError> {
	const res = await cfFetch<CfZone>(`/zones/${creds.zoneId}`, creds).catch(() => null);
	if (!res) return UNREACHABLE;
	if (isAuthFailure(res.status, res.json)) {
		return {
			status: 401,
			error: `Authentication failed: ${cfErrorMessages(res.json)}. Check your token and its permissions (needs Zone Read + Cache Rules Read).`,
		};
	}
	if (res.status === 404 || !res.json?.success) {
		return { status: 404, error: `Zone not found or inaccessible: ${cfErrorMessages(res.json)}` };
	}
	return { zoneName: res.json.result?.name ?? creds.zoneId };
}

export async function fetchRuleShells(creds: CacheCredentials): Promise<{ rules: RuleShell[] } | StepError> {
	const res = await cfFetch<CfRuleset>(
		`/zones/${creds.zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`,
		creds,
	).catch(() => null);
	if (!res) return UNREACHABLE;
	if (res.status === 404) {
		return { rules: [] }; // Zone has no cache rules configured — valid empty state.
	}
	if (res.status === 401 || res.status === 403) {
		return { status: 403, error: `Token lacks Cache Rules permission: ${cfErrorMessages(res.json)}` };
	}
	if (!res.json?.success) {
		return { status: 502, error: `Failed to fetch cache rules: ${cfErrorMessages(res.json)}` };
	}
	const raw = Array.isArray(res.json.result?.rules) ? res.json.result.rules : [];
	return { rules: raw.map(toRuleShell) };
}

/* ---------------------- Version Management ------------------------- */

export type VersioningInfo = {
	enabled: boolean;
	environments: Array<{ name: string; version: number | null }>;
	versionZones: string[];
};

const NO_VERSIONING: VersioningInfo = { enabled: false, environments: [], versionZones: [] };

export async function fetchVersioning(creds: CacheCredentials, zoneName: string): Promise<VersioningInfo> {
	const res = await cfFetch<CfEnvironmentsResult>(`/zones/${creds.zoneId}/environments`, creds).catch(() => null);
	const envs = res?.json?.success ? res.json.result?.environments : null;
	if (!Array.isArray(envs) || envs.length === 0) return NO_VERSIONING;

	const environments = envs.map((e: CfEnvironment) => ({
		name: String(e?.name ?? "environment"),
		version: typeof e?.version === "number" ? e.version : null,
	}));

	// Version zones surface as additional zones with the same name.
	let versionZones: string[] = [];
	const zonesRes = await cfFetch<CfZone[]>(`/zones?name=${encodeURIComponent(zoneName)}&per_page=50`, creds).catch(() => null);
	if (zonesRes?.json?.success && Array.isArray(zonesRes.json.result)) {
		versionZones = zonesRes.json.result
			.map((z) => String(z.id ?? ""))
			.filter((id) => id && id !== creds.zoneId);
	}

	return { enabled: true, environments, versionZones };
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export type AnalyticsBundle = {
	analyticsSource: "path-graphql" | "zero-traffic" | "mock";
	analyticsReason?: string;
	rules: CacheRule[];
	unattributed: UnattributedBlock | null;
	timeseries: TrendBucket[] | null;
	zoneTotals: ZoneTotals | null;
	hosts: string[];
};

function noteUnattributable(shells: RuleShell[], notes: Map<string, string>): CacheRule[] {
	return shells.map((r) => {
		const note = notes.get(r.id);
		if (note !== undefined) {
			return { ...r, attribution: "unattributable" as const, attributionNote: note, analytics: EMPTY_ANALYTICS };
		}
		return { ...r, attribution: "measured" as const, analytics: EMPTY_ANALYTICS };
	});
}

export async function assembleAnalytics(
	ruleShells: RuleShell[],
	creds: CacheCredentials,
	rangeHours: number,
): Promise<AnalyticsBundle> {
	if (ruleShells.length === 0) {
		return { analyticsSource: "zero-traffic", analyticsReason: "no cache rules configured", rules: [], unattributed: null, timeseries: null, zoneTotals: null, hosts: [] };
	}

	const { unattributable } = compileRulePredicates(ruleShells);

	const [pathRes, trendRes, totals] = await Promise.all([
		fetchPathGroups(creds, rangeHours),
		fetchTimeseries(creds, rangeHours),
		fetchZoneTotals(creds, rangeHours),
	]);

	if (!pathRes.ok) {
		// Real analytics unavailable — serve clearly-labeled simulated data.
		return {
			analyticsSource: "mock",
			analyticsReason: pathRes.reason,
			rules: ruleShells.map((r) => ({ ...r, attribution: "mock" as const, analytics: mockAnalytics(r.id, r.enabled) })),
			unattributed: null,
			timeseries: mockTimeseries(creds.zoneId, rangeHours),
			zoneTotals: null,
			hosts: [],
		};
	}

	if (pathRes.groups.length === 0) {
		// A successful empty answer is REAL zero traffic — never mock it.
		const plan = bucketPlan(rangeHours);
		const nowMs = Date.now();
		return {
			analyticsSource: "zero-traffic",
			analyticsReason: "no traffic recorded in the selected window",
			rules: noteUnattributable(ruleShells, unattributable),
			unattributed: null,
			timeseries: [...zeroFilledBuckets(nowMs - rangeHours * 60 * 60 * 1000, nowMs, plan).values()],
			zoneTotals: null,
			hosts: [],
		};
	}

	const { byRule, unattributed, hosts } = attributeAnalytics(ruleShells, pathRes.groups, unattributable.size);
	const rules: CacheRule[] = ruleShells.map((r) => {
		const note = unattributable.get(r.id);
		if (note !== undefined) {
			return { ...r, attribution: "unattributable" as const, attributionNote: note, analytics: EMPTY_ANALYTICS };
		}
		const a = byRule.get(r.id);
		if (a) return { ...r, attribution: "measured" as const, analytics: a.analytics, topUrls: a.topUrls };
		// Disabled rules see no traffic by definition.
		return { ...r, attribution: "measured" as const, analytics: EMPTY_ANALYTICS };
	});

	const ruleTotalOf = (r: CacheRule) => r.analytics.hits + r.analytics.misses + r.analytics.bypass;
	const sampledRequests =
		rules.reduce((sum, r) => sum + ruleTotalOf(r), 0) +
		(unattributed ? unattributed.analytics.hits + unattributed.analytics.misses + unattributed.analytics.bypass : 0);
	const zoneTotals: ZoneTotals | null = totals
		? {
			requests: totals.requests,
			cached: totals.cached,
			sampledRequests,
			coveragePct: Math.min(100, Math.round((sampledRequests / totals.requests) * 1000) / 10),
		}
		: null;

	return {
		analyticsSource: "path-graphql",
		rules,
		unattributed,
		timeseries: trendRes.ok ? trendRes.buckets : null,
		zoneTotals,
		hosts,
	};
}

// Re-export for the URL tester route (client-side eval uses web copy of expr.ts)
export { compileTriState };

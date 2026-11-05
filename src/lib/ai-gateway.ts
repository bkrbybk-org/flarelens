/**
 * AI Gateway usage: request volume, tokens, spend, errors and cache performance for the
 * account's AI Gateway traffic.
 *
 * Distinct from both Workers AI (the account's own inference workloads) and AI Security (LLM
 * traffic inspected for prompt injection / PII / topic detections). This is the proxy layer:
 * what went through the Gateway, to which upstream model, at what cost — for the whole account
 * or drilled into one gateway, provider and/or model.
 *
 * Verified against a real account on 2026-11-04: aiGatewayRequestsAdaptiveGroups carries
 * gateway, provider, model, statusCode, rateLimited, requestId, datetime, durationMs and cached
 * as dimensions; tokensIn, tokensOut, cost, erroredRequests and cachedRequests as sums; and
 * durationMsP50/P95 as quantiles. That one dataset answers everything the page shows, so the
 * drill-down filter applies to all of it. The errors, cache and spend datasets remain fallbacks
 * for an account whose requests dataset lacks those sums.
 */
/**
 * Field names are RESOLVED FROM THE SCHEMA, not hardcoded.
 *
 * The first version of this module guessed them from Cloudflare's naming conventions and was
 * wrong on the first real request: `unknown field "totalTokensIn"`. Guessing then correcting by
 * redeploy is one round trip per wrong name, and the names are not documented anywhere.
 *
 * So this asks instead, the way Request Trace and AI Security already do: introspect the account
 * type for its aiGateway* datasets, introspect each dataset's aggregates and dimensions, and
 * build every query only out of names that actually exist. A dataset or field this account does
 * not expose leaves its panel empty with a stated reason, which is the same contract the rest of
 * the section already had for a missing scope.
 */
import { upstreamFetch } from "./cf-rest";

interface DatasetCaps {
	/** The dataset's real name on the account type. */
	name: string;
	/** Names available inside `sum { ... }`. */
	sums: string[];
	dimensions: string[];
	/** Names available inside `quantiles { ... }` — empty when the dataset has none. */
	quantiles: string[];
	/** Names available inside `uniq { ... }` (distinct counts). */
	uniq: string[];
}

interface ResolvedFields {
	requests:
		| (DatasetCaps & {
				gateway: string | null;
				model: string | null;
				provider: string | null;
				tokensIn: string | null;
				tokensOut: string | null;
				/** Requests served from the Gateway's cache — the numerator for the hit rate. */
				cachedRequests: string | null;
				erroredRequests: string | null;
				cost: string | null;
				statusCode: string | null;
				rateLimited: string | null;
				/** Per-request dimensions: grouping by the request id yields one row per request. */
				requestId: string | null;
				datetime: string | null;
				durationMs: string | null;
				cached: string | null;
				userAgent: string | null;
				latencyP50: string | null;
				latencyP95: string | null;
				/** Distinct users and sessions — counts only; who they are is never selected. */
				uniqueUsers: string | null;
				uniqueSessions: string | null;
				/** Prompt caching at the provider: input tokens read from cache, of all input. */
				cacheReadTokens: string | null;
				contextTokens: string | null;
				requestsWithCacheRead: string | null;
				/** Custom metadata (the cf-aig-metadata header): one row per key, a value per named key, the key list. */
				metadataKey: string | null;
				metadataValue: string | null;
				metadataKeys: string | null;
				/** Every value the request carries, for `_has` filtering (one user's requests). */
				metadataValues: string | null;
		  })
		| null;
	errors: DatasetCaps | null;
	cache: (DatasetCaps & { status: string | null }) | null;
	spend: (DatasetCaps & { cost: string | null }) | null;
	/** Every aiGateway* dataset the schema exposes, so an absence can be evidenced rather than asserted. */
	datasetsSeen: string[];
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * First candidate that exists, in priority order.
 *
 * Deliberately exact-match rather than a regex over the whole list. The first version matched by
 * pattern and picked `cachedTokensIn` for token volume and `abnormalCostSessions` for cost —
 * both real fields answering a different question, both reporting a confident zero. Ordering
 * named candidates makes "the one I actually want, else a documented fallback" explicit.
 */
const prefer = (names: string[], ...candidates: string[]) => candidates.find((c) => names.includes(c)) ?? null;

/** Last resort for dimensions whose spelling genuinely varies between accounts. */
const pick = (names: string[], pattern: RegExp) => names.find((n) => pattern.test(norm(n))) ?? null;

const TYPE_REF = "name ofType { name ofType { name ofType { name ofType { name } } } }";

const ACCOUNT_FIELDS_QUERY = `
query ProbeAccount {
  __type(name: "account") { fields { name type { ${TYPE_REF} } } }
}`;

const TYPE_FIELDS_QUERY = `
query ProbeType($name: String!) {
  __type(name: $name) { fields { name type { ${TYPE_REF} } } }
}`;

interface TypeRef {
	name: string | null;
	ofType: TypeRef | null;
}

interface IntrospectionResponse {
	__type: { fields: { name: string; type: TypeRef }[] | null } | null;
}

function unwrapType(type: TypeRef | null | undefined): string | null {
	let cursor: TypeRef | null | undefined = type;
	while (cursor) {
		if (cursor.name) return cursor.name;
		cursor = cursor.ofType;
	}
	return null;
}

async function introspect(token: string, query: string, variables?: Record<string, unknown>): Promise<IntrospectionResponse | null> {
	const response = await upstreamFetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (response.status === 401 || response.status === 403) {
		throw new AiGatewayUsageError("Cloudflare API request failed", response.status);
	}
	try {
		const body = (await response.json()) as { data?: IntrospectionResponse; errors?: unknown[] };
		return body.errors?.length ? null : (body.data ?? null);
	} catch {
		return null;
	}
}

/** One dataset's aggregate and dimension names, or null when the account does not expose it. */
async function probeDataset(token: string, accountFields: { name: string; type: TypeRef }[], pattern: RegExp): Promise<DatasetCaps | null> {
	const field = accountFields.find((f) => pattern.test(norm(f.name)));
	const typeName = unwrapType(field?.type);
	if (!field || !typeName) return null;

	const rowType = await introspect(token, TYPE_FIELDS_QUERY, { name: typeName });
	const rowFields = rowType?.__type?.fields ?? [];

	const readNames = async (holder: string): Promise<string[]> => {
		const inner = unwrapType(rowFields.find((f) => f.name === holder)?.type);
		if (!inner) return [];
		const type = await introspect(token, TYPE_FIELDS_QUERY, { name: inner });
		return (type?.__type?.fields ?? []).map((f) => f.name);
	};

	const [sums, dimensions, quantiles, uniq] = await Promise.all([readNames("sum"), readNames("dimensions"), readNames("quantiles"), readNames("uniq")]);
	return { name: field.name, sums, dimensions, quantiles, uniq };
}

/**
 * Cached per token for the lifetime of the isolate.
 *
 * Introspection costs four or five round trips and the schema does not change between requests;
 * re-probing on every page load would double this section's latency for nothing. Keyed by token
 * so two operators with different entitlements never share a resolution.
 */
const schemaCache = new Map<string, { value: ResolvedFields; expires: number }>();
const SCHEMA_TTL_MS = 10 * 60 * 1000;

export async function resolveAiGatewayFields(token: string, cacheKey: string): Promise<ResolvedFields> {
	const hit = schemaCache.get(cacheKey);
	if (hit && hit.expires > Date.now()) return hit.value;

	const account = await introspect(token, ACCOUNT_FIELDS_QUERY);
	const accountFields = account?.__type?.fields ?? [];
	const datasetsSeen = accountFields.map((f) => f.name).filter((n) => norm(n).startsWith("aigateway"));

	const [requests, errors, cache, spend] = await Promise.all([
		probeDataset(token, accountFields, /^aigateway.*request/),
		probeDataset(token, accountFields, /^aigateway.*error/),
		probeDataset(token, accountFields, /^aigateway.*cache/),
		probeDataset(token, accountFields, /^aigateway.*spend/),
	]);

	const value: ResolvedFields = {
		requests: requests && {
			...requests,
			gateway: prefer(requests.dimensions, "gateway", "gatewayId", "gatewayName"),
			model: prefer(requests.dimensions, "model", "modelId"),
			provider: prefer(requests.dimensions, "provider"),
			// `tokensIn` is the total; `cachedTokensIn` and `uncachedTokensIn` are its parts, and
			// picking a part reports a fraction of the truth as the whole of it.
			tokensIn: prefer(requests.sums, "tokensIn", "totalTokensIn"),
			tokensOut: prefer(requests.sums, "tokensOut", "totalTokensOut"),
			cachedRequests: prefer(requests.sums, "cachedRequests"),
			erroredRequests: prefer(requests.sums, "erroredRequests"),
			cost: prefer(requests.sums, "cost", "totalCost"),
			statusCode: prefer(requests.dimensions, "statusCode"),
			rateLimited: prefer(requests.dimensions, "rateLimited"),
			requestId: prefer(requests.dimensions, "requestId"),
			datetime: prefer(requests.dimensions, "datetime"),
			durationMs: prefer(requests.dimensions, "durationMs"),
			cached: prefer(requests.dimensions, "cached"),
			userAgent: prefer(requests.dimensions, "userAgent"),
			latencyP50: prefer(requests.quantiles, "durationMsP50"),
			latencyP95: prefer(requests.quantiles, "durationMsP95"),
			uniqueUsers: prefer(requests.uniq, "users"),
			uniqueSessions: prefer(requests.uniq, "sessions"),
			cacheReadTokens: prefer(requests.sums, "cacheReadTokens"),
			// contextTokens = fresh input + cache reads + cache writes: all the input a model saw.
			contextTokens: prefer(requests.sums, "contextTokens"),
			requestsWithCacheRead: prefer(requests.sums, "requestsWithCacheRead"),
			metadataKey: prefer(requests.dimensions, "metadataKey"),
			metadataValue: prefer(requests.dimensions, "metadataValue"),
			metadataKeys: prefer(requests.dimensions, "metadataKeys"),
			metadataValues: prefer(requests.dimensions, "metadataValues"),
		},
		errors,
		cache: cache && { ...cache, status: prefer(cache.dimensions, "cacheStatus", "cacheOp") ?? pick(cache.dimensions, /cach/) },
		// `cost` is the spend total. Every other cost-shaped name on this dataset counts sessions
		// with some property (abnormal, premium, thinking), which is a different quantity.
		spend: spend && { ...spend, cost: prefer(spend.sums, "cost", "totalCost") },
		datasetsSeen,
	};

	schemaCache.set(cacheKey, { value, expires: Date.now() + SCHEMA_TTL_MS });
	return value;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const AI_GATEWAY_GRANULARITIES = ["15m", "hourly", "daily"] as const;
export type AiGatewayGranularity = (typeof AI_GATEWAY_GRANULARITIES)[number];

const TIME_DIMENSION: Record<AiGatewayGranularity, string> = { "15m": "datetimeFifteenMinutes", hourly: "datetimeHour", daily: "date" };

const SERIES_LIMIT = 10_000;
const BREAKDOWN_LIMIT = 100;
/** User × gateway × model combinations read for the flow diagram; the busiest first. */
const FLOW_LIMIT = 500;

/** 30 days, matching every other AdaptiveGroups-backed section here. */
export const MAX_AI_GATEWAY_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export class AiGatewayUsageError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "AiGatewayUsageError";
	}
}

export function isAiGatewayGranularity(value: unknown): value is AiGatewayGranularity {
	return typeof value === "string" && (AI_GATEWAY_GRANULARITIES as readonly string[]).includes(value);
}

interface RawRow {
	count: number;
	dimensions?: Record<string, string | number>;
	sum?: Record<string, number>;
	quantiles?: Record<string, number>;
	uniq?: Record<string, number>;
}

export interface AiGatewaySeriesPoint {
	ts: string;
	requests: number;
	/** null when the schema has no such aggregate. */
	tokens: number | null;
	cost: number | null;
	errors: number | null;
}

export interface AiGatewaySplitPoint {
	ts: string;
	key: string;
	requests: number;
	tokens: number | null;
	cost: number | null;
	errors: number | null;
}

/** One user → gateway → model path, for the flow diagram. A measure the schema lacks is null. */
export interface AiGatewayFlow {
	user: string;
	gateway: string;
	model: string;
	requests: number;
	tokens: number | null;
	cost: number | null;
	/** Failed requests on the path, for its error rate. */
	errors: number | null;
	/** Requests served from the gateway cache, for its hit rate. */
	cached: number | null;
}

/** One slice of traffic — a gateway, provider, model — with every measure the dataset carries. */
export interface AiGatewayBreakdownRow {
	key: string;
	requests: number;
	tokensIn: number | null;
	tokensOut: number | null;
	cost: number | null;
	errors: number | null;
	cached: number | null;
	/** Latency in milliseconds, from the dataset's own quantiles. */
	p50: number | null;
	p95: number | null;
}

/** What sends the traffic: the client named by its user agent ("pi", "opencode", a browser). */
export function clientName(userAgent: string): string {
	const ua = userAgent.trim();
	if (!ua) return "(unknown)";
	if (/^Mozilla\//.test(ua)) return "Browser";
	const product = ua.split(/[/\s(;]/)[0];
	return product || "(unknown)";
}

/**
 * The metadata key whose value names the person who sent a request. The per-user view (decided
 * 2026-11-04) reads this key only, and shows its values as sent — full email addresses — to anyone
 * the deployment admits. Every other key that names people stays refused below.
 */
export const USER_TAG_KEY = "user";

/** A user's value as shown: as sent, trimmed; an empty value is named rather than blank. */
export const userLabel = (raw: string): string => raw.trim() || "(empty)";

/**
 * Tag keys that name a person or a single thing rather than a cost center: a breakdown by them is
 * a per-person (or per-chat) list. Only the user key has one, decided on its own (USER_TAG_KEY);
 * the rest are listed but never broken down. Matched on the key's words: user, email, name, session, chat, ip, phone,
 * account, or anything ending in "id".
 */
export function isSensitiveTagKey(key: string): boolean {
	const words = key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	return words.some((w) => /^(user|users|username|email|mail|name|session|chat|ip|phone|account|owner|customer)$/.test(w)) || /id$/i.test(key);
}

/**
 * A value an allowed key still carries that identifies someone is reduced before it leaves the
 * Worker: an email address to its domain, a long hex identifier to a placeholder.
 */
export function maskTagValue(value: string): string {
	const v = value.trim();
	if (!v) return "(empty)";
	const email = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(v);
	if (email) return `(someone)@${email[1]}`;
	if (/^[0-9a-f]{24,}$/i.test(v)) return "(identifier)";
	return v;
}

export interface AiGatewayTags {
	/** Every key seen in the window, with how many requests carry it. */
	keys: { key: string; requests: number; sensitive: boolean }[];
	selected: string | null;
	/** Requests by the selected key's value, plus "(not tagged)" for those without the key. */
	rows: AiGatewayBreakdownRow[];
	series: AiGatewaySplitPoint[];
}

/** Sessions the spend-sessions dataset flags, by flag. null where the schema has no such flag. */
export interface AiGatewaySessionHealth {
	sessions: number;
	flags: Record<SessionFlag, number | null>;
	/** A drilled-in view filters sessions by their primary model/provider, not every request's. */
	basis: "all" | "primary";
}

export const SESSION_FLAGS = {
	abnormalCost: "flagAbnormalCost",
	abnormalDuration: "flagAbnormalDuration",
	lowCacheHit: "flagLowCacheHit",
	highFirstContext: "flagHighFirstContext",
	highMcpTools: "flagHighMcpTools",
	premiumModel: "flagPremiumModel",
	thinkingModel: "flagThinkingModel",
} as const;
export type SessionFlag = keyof typeof SESSION_FLAGS;

export interface AiGatewayStatusRow {
	statusCode: string;
	rateLimited: boolean;
	requests: number;
}

/** One request, from grouping on the request id. Rows are sampled like every adaptive dataset. */
export interface AiGatewayRequestRow {
	requestId: string;
	datetime: string;
	gateway: string;
	provider: string;
	model: string;
	statusCode: string;
	durationMs: number | null;
	cached: boolean;
	rateLimited: boolean;
	tokensIn: number | null;
	tokensOut: number | null;
	cost: number | null;
	userAgent: string;
	/** The `user` tag's value, or "" when the request carries none. */
	user: string;
}

/** The slice the page is drilled into. Each key is matched exactly. */
export interface AiGatewayFilter {
	gateway?: string;
	provider?: string;
	model?: string;
	/** One `user` tag value: requests carrying the key with that value. */
	user?: string;
}

/** Headline numbers for the window before this one, for the change shown on each card. */
export interface AiGatewayPrevious {
	requests: number;
	sessions: number | null;
	tokens: number | null;
	cost: number | null;
	errorRate: number | null;
	cacheHitRate: number | null;
	p50: number | null;
}

/** A supplementary dataset's fetch outcome — never silently folded into a zero. */
export interface AiGatewayDatasetStatus {
	available: boolean;
	/** Present only when unavailable: why, so the panel can say something truthful. */
	reason?: string;
}

export interface AiGatewayTotals {
	requests: number;
	/** null when the schema exposes no such aggregate — never a confident 0. */
	tokensIn: number | null;
	tokensOut: number | null;
	/** null when the spend dataset (or its cost field) is unavailable — never coerced to 0. */
	cost: number | null;
	/** null when the errors dataset is unavailable. */
	errors: number | null;
	/** null when requests is 0 or errors is unavailable — a genuine 0% is a real value, not this. */
	errorRate: number | null;
	/** null when the cache dataset is unavailable. */
	cacheHits: number | null;
	cacheMisses: number | null;
	/** null when there is no cacheable traffic to compute a rate from, or the dataset failed. */
	cacheHitRate: number | null;
	/** Milliseconds; null when the dataset has no duration quantiles. */
	p50: number | null;
	p95: number | null;
	rateLimited: number | null;
	/** Distinct counts; null when the schema has none. Users is 0 when no user id is sent. */
	users: number | null;
	sessions: number | null;
	/** Provider-side prompt caching. null when the schema carries no such sums. */
	promptCache: { readTokens: number; inputTokens: number; requestsWithRead: number | null } | null;
}

export interface AiGatewayUsageResult {
	granularity: AiGatewayGranularity;
	timeDimension: string;
	series: AiGatewaySeriesPoint[];
	/** The series split by one dimension per bucket; empty for a dimension the schema lacks. */
	seriesBy: { gateway: AiGatewaySplitPoint[]; model: AiGatewaySplitPoint[]; provider: AiGatewaySplitPoint[]; client: AiGatewaySplitPoint[]; user: AiGatewaySplitPoint[] };
	totals: AiGatewayTotals;
	byGateway: AiGatewayBreakdownRow[];
	byProvider: AiGatewayBreakdownRow[];
	byModel: AiGatewayBreakdownRow[];
	byStatus: AiGatewayStatusRow[];
	/** By client application (from the user agent), versions folded together. */
	byClient: AiGatewayBreakdownRow[];
	sessionHealth: (AiGatewaySessionHealth & { available: true }) | { available: false; reason: string };
	/** Cost allocation by custom metadata tag; null when the schema carries no metadata. */
	tags: AiGatewayTags | null;
	/** Requests, tokens and spend per value of the `user` tag, plus "(not tagged)"; null when the schema carries no metadata. */
	byUser: AiGatewayBreakdownRow[] | null;
	/**
	 * Which user sends what through which gateway to which model: one row per combination, busiest
	 * first, with "(not tagged)" for requests no user tag covers. null when the schema has no
	 * metadata, gateway or model dimension.
	 */
	flows: AiGatewayFlow[] | null;
	/** The same paths over the window before (`previousWindow`), to tell new paths from ones that went quiet. */
	previousFlows: AiGatewayFlow[] | null;
	/** The most recent requests in the slice, newest first. Empty when the schema has no request id. */
	recent: AiGatewayRequestRow[];
	previous: AiGatewayPrevious | null;
	previousWindow: { since: string; until: string };
	filter: AiGatewayFilter;
	truncated: boolean;
	/**
	 * Per-dataset fetch status. The requests dataset is load-bearing — if it fails the whole
	 * call throws (see fetchAiGatewayUsage) — so it is not repeated here; these three are the
	 * ones that degrade to an empty, explained panel instead of failing the section.
	 */
	datasets: {
		errors: AiGatewayDatasetStatus;
		cache: AiGatewayDatasetStatus;
		spend: AiGatewayDatasetStatus;
	};
	/**
	 * What the schema probe actually resolved.
	 *
	 * Reported rather than kept internal because a metric reading zero has two very different
	 * causes — no traffic recorded it, or no field was found to sum — and only this tells them
	 * apart. It is also the fastest way to correct a wrong resolution: the names are right here
	 * in the response rather than buried in a query string.
	 */
	schema: {
		datasetsSeen: string[];
		requestsDataset: string | null;
		gatewayDimension: string | null;
		modelDimension: string | null;
		tokensInField: string | null;
		tokensOutField: string | null;
		cacheStatusDimension: string | null;
		costField: string | null;
		/**
		 * The candidate lists each choice was made from.
		 *
		 * Kept in the response because a resolution can be wrong in a way that looks like data:
		 * the first pass matched `cachedTokensIn` for token volume and `abnormalCostSessions`
		 * for cost, both of which are real fields that answer a different question and report
		 * an honest-looking zero. Seeing the alternatives is what makes that diagnosable.
		 */
		candidates: { requestsSums: string[]; requestsDimensions: string[]; cacheDimensions: string[]; spendSums: string[] };
	};
}

interface GraphqlEnvelope<T> {
	errors?: { message?: string }[];
	data?: { viewer?: { accounts?: T[] } };
}

async function postGraphql<T>(accountId: string, token: string, query: string, variables: Record<string, unknown>): Promise<{ account: T | undefined }> {
	const response = await upstreamFetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables: { accountTag: accountId, ...variables } }),
	});
	if (response.status === 401 || response.status === 403) {
		throw new AiGatewayUsageError("Cloudflare API request failed", response.status);
	}
	let envelope: GraphqlEnvelope<T>;
	try {
		envelope = await response.json();
	} catch {
		throw new AiGatewayUsageError("Cloudflare GraphQL returned a non-JSON response", 502);
	}
	if (envelope.errors?.length) {
		throw new AiGatewayUsageError(envelope.errors[0]?.message || "GraphQL query failed", 502);
	}
	return { account: envelope.data?.viewer?.accounts?.[0] };
}

/** Emit a `sum { ... }` selection only when at least one aggregate resolved; an empty one is invalid. */
function sumSelection(names: (string | null)[]): string {
	const present = names.filter((n): n is string => !!n);
	return present.length ? `sum { ${present.join(" ")} }` : "";
}

/** Same for `dimensions { ... }`. */
function dimensionSelection(names: (string | null)[]): string {
	const present = names.filter((n): n is string => !!n);
	return present.length ? `dimensions { ${present.join(" ")} }` : "";
}

/** `quantiles { ... }`, only when one resolved. */
function quantileSelection(names: (string | null)[]): string {
	const present = names.filter((n): n is string => !!n);
	return present.length ? `quantiles { ${present.join(" ")} }` : "";
}

const FILTER_KEYS = ["gateway", "provider", "model"] as const;

/**
 * The filter clause and its variable declarations. Filter values travel as variables; only the
 * field names — taken from the live schema — are written into the query text.
 */
function filterParts(f: NonNullable<ResolvedFields["requests"]>, filter: AiGatewayFilter, since = "$since", until = "$until") {
	const clauses = [`datetime_geq: ${since}`, `datetime_leq: ${until}`];
	const declarations: string[] = [];
	for (const key of FILTER_KEYS) {
		const dimension = f[key];
		if (filter[key] === undefined || !dimension) continue;
		clauses.push(`${dimension}: $f_${key}`);
		declarations.push(`$f_${key}: string`);
	}
	// One user: requests that carry the user key, and carry the value among their values. Checked
	// live (2026-11-04) to select exactly the same requests as grouping by the key's value. Inside
	// AND, so the per-user and per-tag breakdowns can add their own keys_has without a duplicate field.
	if (filter.user !== undefined && f.metadataKeys && f.metadataValues) {
		clauses.push(`AND: [{ ${f.metadataKeys}_has: $f_userKey }, { ${f.metadataValues}_has: $f_user }]`);
		declarations.push("$f_userKey: string", "$f_user: string");
	}
	return { clause: `{ ${clauses.join(", ")} }`, declarations };
}

/** A filter the schema cannot apply (no such dimension) — refused rather than silently ignored. */
export function unsupportedFilters(f: NonNullable<ResolvedFields["requests"]>, filter: AiGatewayFilter): string[] {
	const missing: string[] = FILTER_KEYS.filter((key) => filter[key] !== undefined && !f[key]);
	if (filter.user !== undefined && !(f.metadataKeys && f.metadataValues)) missing.push("user");
	return missing;
}

function requestsQuery(timeDimension: string, f: NonNullable<ResolvedFields["requests"]>, filter: AiGatewayFilter, tag: string | null = null): string {
	const { clause, declarations } = filterParts(f, filter);
	const previous = filterParts(f, filter, "$prevSince", "$prevUntil");
	const measures = `count
        ${sumSelection([f.tokensIn, f.tokensOut, f.cachedRequests, f.erroredRequests, f.cost])}
        ${quantileSelection([f.latencyP50, f.latencyP95])}`;
	const uniq = [f.uniqueUsers, f.uniqueSessions].filter(Boolean);
	const headline = `${measures}
        ${sumSelection([f.cacheReadTokens, f.contextTokens, f.requestsWithCacheRead])}
        ${uniq.length ? `uniq { ${uniq.join(" ")} }` : ""}`;
	// A breakdown whose dimension does not exist is omitted entirely rather than queried against
	// a guessed name — the whole document fails on one unknown field, taking the series with it.
	const breakdown = (alias: string, dimension: string | null) =>
		dimension
			? `
      ${alias}: ${f.name}(filter: ${clause}, limit: $breakdownLimit, orderBy: [count_DESC]) {
        ${measures}
        dimensions { ${dimension} }
      }`
			: "";
	const status = f.statusCode
		? `
      byStatus: ${f.name}(filter: ${clause}, limit: $breakdownLimit, orderBy: [count_DESC]) {
        count
        ${dimensionSelection([f.statusCode, f.rateLimited])}
      }`
		: "";
	const users = Boolean(f.metadataValue && f.metadataKeys);
	const recentDims = [f.requestId, f.datetime, f.gateway, f.provider, f.model, f.statusCode, f.durationMs, f.cached, f.rateLimited, f.userAgent, users ? `${f.metadataValue}(key: $userKey)` : null];
	const recentSums = [f.tokensIn, f.tokensOut, f.cost];
	// Grouping on the request id gives one row per request; ordering by the row's own time
	// makes it "most recent first". Both must exist, or the list is left out.
	const recent =
		f.requestId && f.datetime
			? `
      recent: ${f.name}(filter: ${clause}, limit: $recentLimit, orderBy: [${f.datetime}_DESC]) {
        count
        ${sumSelection(recentSums)}
        ${dimensionSelection(recentDims)}
      }`
			: "";
	// Each bucket split by one dimension, for the stacked chart.
	const splitSeries = (alias: string, dimension: string | null) =>
		dimension
			? `
      ${alias}: ${f.name}(filter: ${clause}, limit: $seriesLimit, orderBy: [${timeDimension}_ASC]) {
        count
        dimensions { ${timeDimension} ${dimension} }
        ${sumSelection([f.tokensIn, f.tokensOut, f.erroredRequests, f.cost])}
      }`
			: "";
	// Tags: the keys in use, and — for one chosen key — requests by its value. The key travels as
	// a variable, into both the filter (requests carrying it) and the value dimension's argument.
	const tagKeys = f.metadataKey
		? `
      tagKeys: ${f.name}(filter: ${clause}, limit: 50, orderBy: [count_DESC]) {
        count
        dimensions { ${f.metadataKey} }
      }`
		: "";
	const tagClause = tag && f.metadataKeys ? clause.replace(/ }$/, `, ${f.metadataKeys}_has: $tagKey }`) : "";
	const tagged =
		tag && f.metadataValue && f.metadataKeys
			? `
      byTag: ${f.name}(filter: ${tagClause}, limit: $breakdownLimit, orderBy: [count_DESC]) {
        ${measures}
        dimensions { ${f.metadataValue}(key: $tagKey) }
      }
      seriesByTag: ${f.name}(filter: ${tagClause}, limit: $seriesLimit, orderBy: [${timeDimension}_ASC]) {
        count
        dimensions { ${timeDimension} ${f.metadataValue}(key: $tagKey) }
        ${sumSelection([f.tokensIn, f.tokensOut, f.erroredRequests, f.cost])}
      }`
			: "";
	// Per user: the `user` key's value, the key itself a variable like any tag key.
	const userClause = users ? clause.replace(/ }$/, `, ${f.metadataKeys}_has: $userKey }`) : "";
	const byUser = users
		? `
      byUser: ${f.name}(filter: ${userClause}, limit: $breakdownLimit, orderBy: [count_DESC]) {
        ${measures}
        dimensions { ${f.metadataValue}(key: $userKey) }
      }
      seriesByUser: ${f.name}(filter: ${userClause}, limit: $seriesLimit, orderBy: [${timeDimension}_ASC]) {
        count
        dimensions { ${timeDimension} ${f.metadataValue}(key: $userKey) }
        ${sumSelection([f.tokensIn, f.tokensOut, f.erroredRequests, f.cost])}
      }`
		: "";
	// Who uses which gateway for which model: tagged requests by user × gateway × model, and all
	// requests by gateway × model, so what no user tag covers still shows as its own flow.
	// The same two over the window before, so the diagram can say which paths are new and which
	// went quiet.
	const flowSums = sumSelection([f.tokensIn, f.tokensOut, f.cost, f.erroredRequests, f.cachedRequests]);
	const flowAliases = (prefix: string, tagged: string, all: string) => `
      ${prefix}flows: ${f.name}(filter: ${tagged}, limit: ${FLOW_LIMIT}, orderBy: [count_DESC]) {
        count
        dimensions { ${f.metadataValue}(key: $userKey) ${f.gateway} ${f.model} }
        ${flowSums}
      }
      ${prefix}flowPairs: ${f.name}(filter: ${all}, limit: ${FLOW_LIMIT}, orderBy: [count_DESC]) {
        count
        dimensions { ${f.gateway} ${f.model} }
        ${flowSums}
      }`;
	const prevUserClause = users ? previous.clause.replace(/ }$/, `, ${f.metadataKeys}_has: $userKey }`) : "";
	const flows = users && f.gateway && f.model ? flowAliases("", userClause, clause) + flowAliases("prev_", prevUserClause, previous.clause) : "";
	const declared = [...new Set([...declarations, ...previous.declarations, ...(tagged ? ["$tagKey: string!"] : []), ...(users ? ["$userKey: string!"] : [])])].map((d) => `, ${d}`).join("");

	return `
query AiGatewayRequests($accountTag: string!, $since: Time!, $until: Time!, $prevSince: Time!, $prevUntil: Time!, $seriesLimit: Int!, $breakdownLimit: Int!, $recentLimit: Int!${declared}) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      series: ${f.name}(filter: ${clause}, limit: $seriesLimit, orderBy: [${timeDimension}_ASC]) {
        count
        dimensions { ${timeDimension} }
        ${sumSelection([f.tokensIn, f.tokensOut, f.cachedRequests, f.erroredRequests, f.cost])}
      }
      total: ${f.name}(filter: ${clause}, limit: 1) {
        ${headline}
      }
      previous: ${f.name}(filter: ${previous.clause}, limit: 1) {
        ${headline}
      }${splitSeries("seriesByGateway", f.gateway)}${splitSeries("seriesByModel", f.model)}${splitSeries("seriesByProvider", f.provider)}${splitSeries("seriesByClient", f.userAgent)}${breakdown("byGateway", f.gateway)}${breakdown("byProvider", f.provider)}${breakdown("byModel", f.model)}${breakdown("byClient", f.userAgent)}${status}${recent}${tagKeys}${tagged}${byUser}${flows}
    }
  }
}`;
}

/** Filters for the sessions dataset: a session's gateway, and its primary model and provider. */
const SESSION_FILTER: Record<(typeof FILTER_KEYS)[number], string> = { gateway: "gateway", model: "primaryModel", provider: "primaryProvider" };

/**
 * Sessions in the window, and how many carry each health flag. The flags are 0/1 dimensions on
 * the spend-sessions dataset (its cost and count sums read zero on the account this was built
 * against), so each is counted with its own filter. The literal 1 is the only value written into
 * the query; filter values are variables.
 */
function sessionHealthQuery(spend: DatasetCaps, filter: AiGatewayFilter): { query: string; flags: SessionFlag[] } {
	const clauses = ["datetime_geq: $since", "datetime_leq: $until"];
	const declarations: string[] = [];
	for (const key of FILTER_KEYS) {
		if (filter[key] === undefined) continue;
		clauses.push(`${SESSION_FILTER[key]}: $f_${key}`);
		declarations.push(`, $f_${key}: string`);
	}
	const flags = (Object.keys(SESSION_FLAGS) as SessionFlag[]).filter((flag) => spend.dimensions.includes(SESSION_FLAGS[flag]));
	const base = clauses.join(", ");
	const aliases = flags.map((flag) => `${flag}: ${spend.name}(filter: { ${base}, ${SESSION_FLAGS[flag]}: 1 }, limit: 1) { count }`).join("\n      ");
	return {
		flags,
		query: `
query AiGatewaySessions($accountTag: string!, $since: Time!, $until: Time!${declarations.join("")}) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      sessions: ${spend.name}(filter: { ${base} }, limit: 1) { count }
      ${aliases}
    }
  }
}`,
	};
}

function errorsQuery(f: DatasetCaps): string {
	return `
query AiGatewayErrors($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: ${f.name}(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $breakdownLimit) {
        count
      }
    }
  }
}`;
}

function cacheQuery(f: NonNullable<ResolvedFields["cache"]>): string {
	return `
query AiGatewayCache($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      byStatus: ${f.name}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        ${dimensionSelection([f.status])}
      }
    }
  }
}`;
}

function spendQuery(f: NonNullable<ResolvedFields["spend"]>): string {
	return `
query AiGatewaySpend($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: ${f.name}(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $breakdownLimit) {
        ${sumSelection([f.cost])}
      }
    }
  }
}`;
}

/** Any value naming a hit counts as one; everything else — including an unfamiliar value — is a
 *  miss rather than a silently-invented hit, same reasoning as isBlockedVerdict in gateway-usage.ts. */
function isCacheHit(value: unknown): boolean {
	return String(value ?? "").toLowerCase().includes("hit");
}

const sumField = (row: RawRow | undefined, field: string | null): number | null => (field ? (row?.sum?.[field] ?? 0) : null);
const uniqOf = (row: RawRow | undefined, field: string | null): number | null => (field ? (row?.uniq?.[field] ?? 0) : null);
const addNullable = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/** One bucket's share for one gateway/model/provider, for the stacked chart. */
function foldSplit(
	rows: RawRow[],
	timeDimension: string,
	dimension: string | null,
	f: NonNullable<ResolvedFields["requests"]>,
	keyOf: (raw: string) => string = (raw) => raw.trim() || "(unknown)",
): AiGatewaySplitPoint[] {
	if (!dimension) return [];
	return rows
		.filter((row) => row.dimensions?.[timeDimension])
		.map((row) => ({
			ts: String(row.dimensions?.[timeDimension]),
			key: keyOf(String(row.dimensions?.[dimension] ?? "")),
			requests: row.count,
			tokens: addNullable(sumField(row, f.tokensIn), sumField(row, f.tokensOut)),
			cost: sumField(row, f.cost),
			errors: sumField(row, f.erroredRequests),
		}));
}

function foldSeries(rows: RawRow[], timeDimension: string, f: NonNullable<ResolvedFields["requests"]>): AiGatewaySeriesPoint[] {
	const byTs = new Map<string, AiGatewaySeriesPoint>();
	for (const row of rows) {
		const ts = String(row.dimensions?.[timeDimension] ?? "");
		if (!ts) continue;
		const point = byTs.get(ts) ?? { ts, requests: 0, tokens: null, cost: null, errors: null };
		point.requests += row.count;
		point.tokens = addNullable(point.tokens, addNullable(sumField(row, f.tokensIn), sumField(row, f.tokensOut)));
		point.cost = addNullable(point.cost, sumField(row, f.cost));
		point.errors = addNullable(point.errors, sumField(row, f.erroredRequests));
		byTs.set(ts, point);
	}
	return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

const quantile = (row: RawRow | undefined, field: string | null): number | null => {
	const value = field ? row?.quantiles?.[field] : undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

function foldBreakdown(
	rows: RawRow[],
	dimension: string,
	f: NonNullable<ResolvedFields["requests"]>,
	keyOf: (raw: string) => string = (raw) => raw.trim() || "(unknown)",
): AiGatewayBreakdownRow[] {
	const byKey = new Map<string, AiGatewayBreakdownRow>();
	const merged = new Set<string>();
	for (const row of rows) {
		const key = keyOf(String(row.dimensions?.[dimension] ?? ""));
		if (byKey.has(key)) merged.add(key);
		const entry = byKey.get(key) ?? { key, requests: 0, tokensIn: null, tokensOut: null, cost: null, errors: null, cached: null, p50: null, p95: null };
		entry.requests += row.count;
		entry.tokensIn = addNullable(entry.tokensIn, sumField(row, f.tokensIn));
		entry.tokensOut = addNullable(entry.tokensOut, sumField(row, f.tokensOut));
		entry.cost = addNullable(entry.cost, sumField(row, f.cost));
		entry.errors = addNullable(entry.errors, sumField(row, f.erroredRequests));
		entry.cached = addNullable(entry.cached, sumField(row, f.cachedRequests));
		// One row per key in practice; a second row (an empty key folded into "(unknown)") keeps the first's quantiles.
		entry.p50 ??= quantile(row, f.latencyP50);
		entry.p95 ??= quantile(row, f.latencyP95);
		byKey.set(key, entry);
	}
	// Quantiles do not add: a key folded from several rows (client versions) has no honest p50.
	for (const key of merged) {
		const entry = byKey.get(key)!;
		entry.p50 = null;
		entry.p95 = null;
	}
	return [...byKey.values()].sort((a, b) => b.requests - a.requests);
}

/** What the tagged rows leave of the totals: requests nobody has tagged with the key. */
function withUntagged(rows: AiGatewayBreakdownRow[], totals: AiGatewayTotals): AiGatewayBreakdownRow[] {
	const sumOf = (pick: (r: AiGatewayBreakdownRow) => number | null) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
	// Spend is a float: the total less the tagged rows can leave 4e-16 where the answer is 0.
	// Anything within a billionth of the whole is that residue, not an untagged share.
	const rest = (whole: number | null, pick: (r: AiGatewayBreakdownRow) => number | null) => {
		if (whole === null) return null;
		const left = whole - sumOf(pick);
		return left <= Math.abs(whole) * 1e-9 ? 0 : left;
	};
	const untagged = totals.requests - sumOf((r) => r.requests);
	if (untagged <= 0) return rows;
	return [
		...rows,
		{
			key: "(not tagged)",
			requests: untagged,
			tokensIn: rest(totals.tokensIn, (r) => r.tokensIn),
			tokensOut: rest(totals.tokensOut, (r) => r.tokensOut),
			cost: rest(totals.cost, (r) => r.cost),
			errors: rest(totals.errors, (r) => r.errors),
			cached: rest(totals.cacheHits, (r) => r.cached),
			p50: null,
			p95: null,
		},
	];
}

/**
 * The flow rows: tagged requests per user, gateway and model as they come, then, per gateway and
 * model, whatever the tagged rows leave of all requests as a "(not tagged)" flow. A float measure's
 * residue within a billionth of the pair's total is 0, as in withUntagged.
 */
function foldFlows(tagged: RawRow[], pairs: RawRow[], f: NonNullable<ResolvedFields["requests"]>): AiGatewayFlow[] {
	type Measures = Pick<AiGatewayFlow, "requests" | "tokens" | "cost" | "errors" | "cached">;
	const gatewayOf = (row: RawRow) => text(row.dimensions?.[f.gateway as string]).trim() || "(unknown)";
	const modelOf = (row: RawRow) => text(row.dimensions?.[f.model as string]).trim() || "(unknown)";
	// Each measure of one row; null where the schema has no such field, as everywhere else here.
	const measuresOf = (row: RawRow): Measures => ({
		requests: row.count,
		tokens: addNullable(sumField(row, f.tokensIn), sumField(row, f.tokensOut)),
		cost: sumField(row, f.cost),
		errors: sumField(row, f.erroredRequests),
		cached: sumField(row, f.cachedRequests),
	});
	const add = (into: Measures, row: Measures) => {
		into.requests += row.requests;
		into.tokens = addNullable(into.tokens, row.tokens);
		into.cost = addNullable(into.cost, row.cost);
		into.errors = addNullable(into.errors, row.errors);
		into.cached = addNullable(into.cached, row.cached);
	};
	const empty = (): Measures => ({ requests: 0, tokens: null, cost: null, errors: null, cached: null });
	const byPath = new Map<string, AiGatewayFlow>();
	const covered = new Map<string, Measures>();
	for (const row of tagged) {
		const user = userLabel(text(row.dimensions?.[f.metadataValue as string]));
		const gateway = gatewayOf(row);
		const model = modelOf(row);
		const measures = measuresOf(row);
		const path = JSON.stringify([user, gateway, model]);
		const flow = byPath.get(path) ?? { user, gateway, model, ...empty() };
		add(flow, measures);
		byPath.set(path, flow);
		const pair = JSON.stringify([gateway, model]);
		const seen = covered.get(pair) ?? empty();
		add(seen, measures);
		covered.set(pair, seen);
	}
	const left = (whole: number | null, part: number | null) => {
		if (whole === null) return null;
		const rest = whole - (part ?? 0);
		return rest <= Math.abs(whole) * 1e-9 ? 0 : rest;
	};
	const untagged: AiGatewayFlow[] = [];
	for (const row of pairs) {
		const gateway = gatewayOf(row);
		const model = modelOf(row);
		const whole = measuresOf(row);
		const seen = covered.get(JSON.stringify([gateway, model])) ?? empty();
		const requests = whole.requests - seen.requests;
		if (requests <= 0) continue;
		untagged.push({
			user: "(not tagged)",
			gateway,
			model,
			requests,
			tokens: left(whole.tokens, seen.tokens),
			cost: left(whole.cost, seen.cost),
			errors: left(whole.errors, seen.errors),
			cached: left(whole.cached, seen.cached),
		});
	}
	return [...byPath.values(), ...untagged].sort((a, b) => b.requests - a.requests);
}

const flag = (value: unknown) => value === 1 || value === true || value === "1" || value === "true";
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function foldRecent(rows: RawRow[], f: NonNullable<ResolvedFields["requests"]>): AiGatewayRequestRow[] {
	const dim = (row: RawRow, name: string | null) => (name ? row.dimensions?.[name] : undefined);
	return rows.map((row) => {
		const duration = Number(dim(row, f.durationMs));
		return {
			requestId: text(dim(row, f.requestId)),
			datetime: text(dim(row, f.datetime)),
			gateway: text(dim(row, f.gateway)),
			provider: text(dim(row, f.provider)),
			model: text(dim(row, f.model)),
			statusCode: text(dim(row, f.statusCode)),
			durationMs: f.durationMs && Number.isFinite(duration) ? duration : null,
			cached: flag(dim(row, f.cached)),
			rateLimited: flag(dim(row, f.rateLimited)),
			tokensIn: sumField(row, f.tokensIn),
			tokensOut: sumField(row, f.tokensOut),
			cost: sumField(row, f.cost),
			userAgent: text(dim(row, f.userAgent)),
			user: f.metadataValue && f.metadataKeys ? text(dim(row, f.metadataValue)).trim() : "",
		};
	});
}

/** The window of the same length immediately before this one. */
export function previousWindow(since: string, until: string): { since: string; until: string } {
	const length = Date.parse(until) - Date.parse(since);
	return { since: new Date(Date.parse(since) - length).toISOString(), until: since };
}

const RECENT_LIMIT = 50;

export async function fetchAiGatewayUsage(
	accountId: string,
	token: string,
	options: { since: string; until: string; granularity: AiGatewayGranularity; filter?: AiGatewayFilter; tag?: string },
): Promise<AiGatewayUsageResult> {
	let granularity = options.granularity;
	const filter = options.filter ?? {};
	const prev = previousWindow(options.since, options.until);
	const variables = { since: options.since, until: options.until, seriesLimit: SERIES_LIMIT, breakdownLimit: BREAKDOWN_LIMIT };
	const filterVariables = Object.fromEntries(FILTER_KEYS.filter((k) => filter[k] !== undefined).map((k) => [`f_${k}`, filter[k]]));
	const userVariables = filter.user !== undefined ? { f_user: filter.user, f_userKey: USER_TAG_KEY } : {};
	const filtered = Object.keys(filterVariables).length > 0 || filter.user !== undefined;

	const fields = await resolveAiGatewayFields(token, accountId);

	// No requests dataset means this account has no AI Gateway analytics at all — a stated
	// absence, not an error, and not an empty chart implying zero traffic.
	if (!fields.requests) {
		const seen = fields.datasetsSeen.length ? ` The schema exposes ${fields.datasetsSeen.join(", ")}.` : "";
		throw new AiGatewayUsageError(
			`This account's GraphQL schema exposes no AI Gateway requests dataset, so there is nothing to report.${seen}`,
			502,
		);
	}

	const unsupported = unsupportedFilters(fields.requests, filter);
	if (unsupported.length) {
		throw new AiGatewayUsageError(`This account's AI Gateway dataset cannot be filtered by ${unsupported.join(", ")}`, 400);
	}
	const tag = options.tag ?? null;
	if (tag && isSensitiveTagKey(tag)) {
		throw new AiGatewayUsageError(`The "${tag}" tag identifies people or single items, so it is not broken down`, 400);
	}
	// 15-minute buckets only where the schema has them; hourly is the floor every account carries.
	if (granularity === "15m" && !fields.requests.dimensions.includes(TIME_DIMENSION["15m"])) granularity = "hourly";
	const timeDimension = TIME_DIMENSION[granularity];

	interface RequestsAccount {
		series?: RawRow[];
		seriesByGateway?: RawRow[];
		seriesByModel?: RawRow[];
		seriesByProvider?: RawRow[];
		seriesByClient?: RawRow[];
		byClient?: RawRow[];
		tagKeys?: RawRow[];
		byTag?: RawRow[];
		seriesByTag?: RawRow[];
		byUser?: RawRow[];
		seriesByUser?: RawRow[];
		flows?: RawRow[];
		flowPairs?: RawRow[];
		prev_flows?: RawRow[];
		prev_flowPairs?: RawRow[];
		total?: RawRow[];
		previous?: RawRow[];
		byGateway?: RawRow[];
		byProvider?: RawRow[];
		byModel?: RawRow[];
		byStatus?: RawRow[];
		recent?: RawRow[];
	}
	const { account } = await postGraphql<RequestsAccount>(accountId, token, requestsQuery(timeDimension, fields.requests, filter, tag), {
		...(tag ? { tagKey: tag } : {}),
		...(fields.requests.metadataValue && fields.requests.metadataKeys ? { userKey: USER_TAG_KEY } : {}),
		...variables,
		...filterVariables,
		...userVariables,
		prevSince: prev.since,
		prevUntil: prev.until,
		recentLimit: RECENT_LIMIT,
	});
	const seriesRows = account?.series || [];
	const series = foldSeries(seriesRows, timeDimension, fields.requests);
	const totalRow = account?.total?.[0];
	// The ungrouped total is authoritative; the series sum stands in where it is absent.
	const requests = totalRow ? totalRow.count : series.reduce((sum, p) => sum + p.requests, 0);

	// A token field the schema does not expose stays null rather than summing to a confident 0.
	const sumOf = (field: string | null): number | null =>
		!field ? null : totalRow ? (totalRow.sum?.[field] ?? 0) : seriesRows.reduce((total, row) => total + (row.sum?.[field] ?? 0), 0);
	const tokensIn = sumOf(fields.requests.tokensIn);
	const tokensOut = sumOf(fields.requests.tokensOut);
	// Cache, errors and cost come from the requests dataset when it carries them: it is the one
	// dataset already proven to answer, and `cachedRequests` is an exact count of cache-served
	// requests where the cache dataset's own dimension would need its vocabulary interpreted.
	const cachedRequests = sumOf(fields.requests.cachedRequests);
	const inlineErrors = sumOf(fields.requests.erroredRequests);
	const inlineCost = sumOf(fields.requests.cost);

	// The three supplementary datasets each degrade independently: an absent dataset (or a
	// dimension this account does not carry) empties that one panel with a stated reason instead
	// of taking the whole section down. Run them concurrently since none depends on another.
	// They carry no gateway/provider/model filter here, so on a drilled-in view they would report
	// the whole account as the slice — left out instead.
	const sliceOnly = (dataset: string) => Promise.reject(new Error(`The ${dataset} dataset is not filtered to this slice`));
	const sessions = fields.spend ? sessionHealthQuery(fields.spend, filter) : null;
	const [errorsOutcome, cacheOutcome, spendOutcome, sessionsOutcome] = await Promise.allSettled([
		filtered && inlineErrors === null ? sliceOnly("errors") : fields.errors ? postGraphql<{ total?: RawRow[] }>(accountId, token, errorsQuery(fields.errors), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway errors dataset")),
		filtered && cachedRequests === null ? sliceOnly("cache") : fields.cache ? postGraphql<{ byStatus?: RawRow[] }>(accountId, token, cacheQuery(fields.cache), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway cache dataset")),
		filtered && inlineCost === null ? sliceOnly("spend") : fields.spend ? postGraphql<{ total?: RawRow[] }>(accountId, token, spendQuery(fields.spend), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway spend dataset")),
		filter.user !== undefined
			? Promise.reject(new Error("Session analysis cannot be narrowed to one user"))
			: sessions
			? postGraphql<Record<string, RawRow[] | undefined>>(accountId, token, sessions.query, { since: options.since, until: options.until, ...filterVariables })
			: Promise.reject(new Error("This account's schema exposes no AI Gateway sessions dataset")),
	]);

	const reasonOf = (outcome: PromiseSettledResult<unknown>): string =>
		outcome.status === "rejected"
			? outcome.reason instanceof Error
				? outcome.reason.message
				: "Failed to load"
			: "";

	let errors: number | null = inlineErrors;
	const errorsStatus: AiGatewayDatasetStatus = { available: inlineErrors !== null };
	if (inlineErrors === null && errorsOutcome.status === "fulfilled") {
		errors = (errorsOutcome.value.account?.total || []).reduce((sum, row) => sum + row.count, 0);
		errorsStatus.available = true;
	} else if (inlineErrors === null) {
		errorsStatus.reason = reasonOf(errorsOutcome);
	}

	let cacheHits: number | null = cachedRequests;
	let cacheMisses: number | null = cachedRequests === null ? null : Math.max(0, requests - cachedRequests);
	const cacheStatus: AiGatewayDatasetStatus = { available: cachedRequests !== null };
	if (cachedRequests === null && cacheOutcome.status === "fulfilled" && fields.cache?.status) {
		const rows = cacheOutcome.value.account?.byStatus || [];
		cacheHits = 0;
		cacheMisses = 0;
		for (const row of rows) {
			if (isCacheHit(row.dimensions?.[fields.cache.status])) cacheHits += row.count;
			else cacheMisses += row.count;
		}
		cacheStatus.available = true;
	} else if (cachedRequests === null) {
		// Present but with no status dimension is still unusable: hits and misses would be
		// indistinguishable, and reporting every row as a miss would invent a 0% hit rate.
		cacheStatus.reason = cacheOutcome.status === "fulfilled" ? "The cache dataset exposes no status dimension, so hits cannot be told from misses" : reasonOf(cacheOutcome);
	}

	let cost: number | null = inlineCost;
	const spendStatus: AiGatewayDatasetStatus = { available: inlineCost !== null };
	if (inlineCost === null && spendOutcome.status === "fulfilled" && fields.spend?.cost) {
		const rows = spendOutcome.value.account?.total || [];
		// No rows stays null rather than 0: until this has been seen against real data, an empty
		// spend result cannot be told apart from a dataset that does not answer in this shape,
		// and a confident $0 is the more damaging of the two readings.
		if (rows.length) cost = rows.reduce((sum, row) => sum + (row.sum?.[fields.spend!.cost as string] ?? 0), 0);
		spendStatus.available = true;
	} else if (inlineCost === null) {
		spendStatus.reason = spendOutcome.status === "fulfilled" ? "The spend dataset exposes no cost aggregate" : reasonOf(spendOutcome);
	}

	const cacheDenominator = cacheHits !== null && cacheMisses !== null ? cacheHits + cacheMisses : 0;

	const totals: AiGatewayTotals = {
		requests,
		tokensIn,
		tokensOut,
		cost,
		errors,
		// A zero denominator must read as "no data", never as a fabricated 0%.
		errorRate: requests > 0 && errors !== null ? errors / requests : null,
		cacheHits,
		cacheMisses,
		cacheHitRate: cacheDenominator > 0 ? (cacheHits as number) / cacheDenominator : null,
		p50: quantile(totalRow, fields.requests.latencyP50),
		p95: quantile(totalRow, fields.requests.latencyP95),
		rateLimited: null,
		users: uniqOf(totalRow, fields.requests.uniqueUsers),
		sessions: uniqOf(totalRow, fields.requests.uniqueSessions),
		promptCache:
			fields.requests.cacheReadTokens && fields.requests.contextTokens
				? {
						readTokens: sumField(totalRow, fields.requests.cacheReadTokens) ?? 0,
						inputTokens: sumField(totalRow, fields.requests.contextTokens) ?? 0,
						requestsWithRead: sumField(totalRow, fields.requests.requestsWithCacheRead),
					}
				: null,
	};

	let sessionHealth: AiGatewayUsageResult["sessionHealth"];
	if (sessions && sessionsOutcome.status === "fulfilled") {
		const account = sessionsOutcome.value.account ?? {};
		const count = (alias: string) => (account[alias] ?? []).reduce((sum, row) => sum + row.count, 0);
		const flags = Object.fromEntries((Object.keys(SESSION_FLAGS) as SessionFlag[]).map((flag) => [flag, sessions.flags.includes(flag) ? count(flag) : null])) as Record<SessionFlag, number | null>;
		sessionHealth = { available: true, sessions: count("sessions"), flags, basis: filter.model || filter.provider ? "primary" : "all" };
	} else {
		sessionHealth = { available: false, reason: reasonOf(sessionsOutcome) };
	}

	const byStatus: AiGatewayStatusRow[] = (account?.byStatus || []).map((row) => ({
		statusCode: text(row.dimensions?.[fields.requests!.statusCode as string]) || "(unknown)",
		rateLimited: flag(fields.requests!.rateLimited ? row.dimensions?.[fields.requests!.rateLimited] : 0),
		requests: row.count,
	}));
	if (fields.requests.rateLimited && account?.byStatus) {
		totals.rateLimited = byStatus.filter((r) => r.rateLimited).reduce((sum, r) => sum + r.requests, 0);
	}

	let tags: AiGatewayTags | null = null;
	const md = fields.requests;
	if (md.metadataKey) {
		const keys = (account?.tagKeys || [])
			.map((row) => ({ key: text(row.dimensions?.[md.metadataKey as string]).trim(), requests: row.count }))
			.filter((k) => k.key)
			.map((k) => ({ ...k, sensitive: isSensitiveTagKey(k.key) }));
		let rows: AiGatewayBreakdownRow[] = [];
		let tagSeries: AiGatewaySplitPoint[] = [];
		if (tag && md.metadataValue) {
			// What the tagged rows leave of the total is the untagged remainder — the share nobody
			// has allocated yet, which is often the point of the exercise.
			rows = withUntagged(foldBreakdown(account?.byTag || [], md.metadataValue, md, maskTagValue), totals);
			tagSeries = foldSplit(account?.seriesByTag || [], timeDimension, md.metadataValue, md, maskTagValue);
		}
		tags = { keys, selected: tag, rows, series: tagSeries };
	}
	// Per user, values as sent (the decision recorded at USER_TAG_KEY), with what nobody tagged.
	const hasUsers = Boolean(md.metadataValue && md.metadataKeys);
	const byUser = hasUsers ? withUntagged(foldBreakdown(account?.byUser || [], md.metadataValue as string, md, userLabel), totals) : null;

	const prevRow = account?.previous?.[0];
	const prevField = (field: string | null) => sumField(prevRow, field);
	const prevRequests = prevRow?.count ?? 0;
	const prevErrors = prevField(fields.requests.erroredRequests);
	const prevCached = prevField(fields.requests.cachedRequests);
	const previous: AiGatewayPrevious | null = prevRow
		? {
				requests: prevRequests,
				sessions: uniqOf(prevRow, fields.requests.uniqueSessions),
				tokens: addNullable(prevField(fields.requests.tokensIn), prevField(fields.requests.tokensOut)),
				cost: prevField(fields.requests.cost),
				errorRate: prevRequests > 0 && prevErrors !== null ? prevErrors / prevRequests : null,
				cacheHitRate: prevRequests > 0 && prevCached !== null ? prevCached / prevRequests : null,
				p50: quantile(prevRow, fields.requests.latencyP50),
			}
		: null;

	return {
		granularity,
		timeDimension,
		series,
		seriesBy: {
			gateway: foldSplit(account?.seriesByGateway || [], timeDimension, fields.requests.gateway, fields.requests),
			model: foldSplit(account?.seriesByModel || [], timeDimension, fields.requests.model, fields.requests),
			provider: foldSplit(account?.seriesByProvider || [], timeDimension, fields.requests.provider, fields.requests),
			client: foldSplit(account?.seriesByClient || [], timeDimension, fields.requests.userAgent, fields.requests, clientName),
			user: hasUsers ? foldSplit(account?.seriesByUser || [], timeDimension, md.metadataValue, md, userLabel) : [],
		},
		totals,
		byGateway: fields.requests.gateway ? foldBreakdown(account?.byGateway || [], fields.requests.gateway, fields.requests) : [],
		byProvider: fields.requests.provider ? foldBreakdown(account?.byProvider || [], fields.requests.provider, fields.requests) : [],
		byModel: fields.requests.model ? foldBreakdown(account?.byModel || [], fields.requests.model, fields.requests) : [],
		byStatus,
		byClient: fields.requests.userAgent ? foldBreakdown(account?.byClient || [], fields.requests.userAgent, fields.requests, clientName) : [],
		sessionHealth,
		tags,
		byUser,
		flows: hasUsers && md.gateway && md.model ? foldFlows(account?.flows || [], account?.flowPairs || [], md) : null,
		previousFlows: hasUsers && md.gateway && md.model ? foldFlows(account?.prev_flows || [], account?.prev_flowPairs || [], md) : null,
		recent: foldRecent(account?.recent || [], fields.requests),
		previous,
		previousWindow: prev,
		filter,
		truncated: seriesRows.length >= SERIES_LIMIT,
		datasets: { errors: errorsStatus, cache: cacheStatus, spend: spendStatus },
		schema: {
			datasetsSeen: fields.datasetsSeen,
			requestsDataset: fields.requests.name,
			gatewayDimension: fields.requests.gateway,
			modelDimension: fields.requests.model,
			tokensInField: fields.requests.tokensIn,
			tokensOutField: fields.requests.tokensOut,
			cacheStatusDimension: fields.cache?.status ?? null,
			costField: fields.spend?.cost ?? null,
			candidates: {
				requestsSums: fields.requests.sums,
				requestsDimensions: fields.requests.dimensions,
				cacheDimensions: fields.cache?.dimensions ?? [],
				spendSums: fields.spend?.sums ?? [],
			},
		},
	};
}

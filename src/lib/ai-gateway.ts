/**
 * AI Gateway usage: request volume, tokens, spend, errors and cache performance for the
 * account's AI Gateway traffic.
 *
 * Distinct from both Workers AI (the account's own inference workloads) and AI Security (LLM
 * traffic inspected for prompt injection / PII / topic detections). This is the proxy layer:
 * what went through the Gateway, to which upstream model, at what cost.
 *
 * ==========================================================================================
 * UNVERIFIED FIELD NAMES — read before touching this file
 * ==========================================================================================
 * There is no Cloudflare API token in this environment, so nothing below has been run against
 * a live schema or a real query. Every dataset and field name is a guess, derived from two
 * sources only:
 *   (a) the naming convention every other *AdaptiveGroups dataset in this repo already follows
 *       — datetimeHour/date time dimensions, `count`, `sum { totalX }` aggregates, singular
 *       camelCase dimension names (modelId, requestSource, errorCode, resolverDecision) — and
 *   (b) Cloudflare's public AI Gateway docs, which describe per-gateway analytics (requests,
 *       tokens, cost, cache, errors, by-provider/model breakdowns) without ever naming the
 *       underlying GraphQL fields.
 *
 * FIELDS below is the single place every guess lives. If a probe against a real account finds
 * a different name, correct it here — every query string and fold in this file references
 * these constants, never a field-name string literal of its own.
 *
 * Per-field confidence, so a probe knows where to look first:
 *   HIGH   — matches a convention already confirmed live elsewhere in this codebase
 *   MEDIUM — plausible camelCase of a documented Logpush/dashboard field, unconfirmed as GraphQL
 *   LOW    — no direct precedent; could easily be named, shaped or scoped differently
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
interface DatasetCaps {
	/** The dataset's real name on the account type. */
	name: string;
	/** Names available inside `sum { ... }`. */
	sums: string[];
	dimensions: string[];
}

interface ResolvedFields {
	requests: (DatasetCaps & { gateway: string | null; model: string | null; provider: string | null; tokensIn: string | null; tokensOut: string | null }) | null;
	errors: DatasetCaps | null;
	cache: (DatasetCaps & { status: string | null }) | null;
	spend: (DatasetCaps & { cost: string | null }) | null;
	/** Every aiGateway* dataset the schema exposes, so an absence can be evidenced rather than asserted. */
	datasetsSeen: string[];
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
	const response = await fetch(GRAPHQL_ENDPOINT, {
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

	return { name: field.name, sums: await readNames("sum"), dimensions: await readNames("dimensions") };
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
			gateway: pick(requests.dimensions, /gateway/),
			model: pick(requests.dimensions, /model/),
			provider: pick(requests.dimensions, /provider/),
			// Token counts are the field names that were wrong first time round; match on shape.
			tokensIn: pick(requests.sums, /token.*in|input.*token|promptttoken|prompttoken/),
			tokensOut: pick(requests.sums, /token.*out|output.*token|completiontoken/),
		},
		errors,
		cache: cache && { ...cache, status: pick(cache.dimensions, /cach|status|hit/) },
		spend: spend && { ...spend, cost: pick(spend.sums, /cost|spend|amount/) },
		datasetsSeen,
	};

	schemaCache.set(cacheKey, { value, expires: Date.now() + SCHEMA_TTL_MS });
	return value;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const AI_GATEWAY_GRANULARITIES = ["hourly", "daily"] as const;
export type AiGatewayGranularity = (typeof AI_GATEWAY_GRANULARITIES)[number];

const TIME_DIMENSION: Record<AiGatewayGranularity, string> = { hourly: "datetimeHour", daily: "date" };

const SERIES_LIMIT = 10_000;
const BREAKDOWN_LIMIT = 100;

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
}

export interface AiGatewaySeriesPoint {
	ts: string;
	requests: number;
}

export interface AiGatewayBreakdownRow {
	key: string;
	requests: number;
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
}

export interface AiGatewayUsageResult {
	granularity: AiGatewayGranularity;
	timeDimension: string;
	series: AiGatewaySeriesPoint[];
	totals: AiGatewayTotals;
	byGateway: AiGatewayBreakdownRow[];
	byModel: AiGatewayBreakdownRow[];
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
}

interface GraphqlEnvelope<T> {
	errors?: { message?: string }[];
	data?: { viewer?: { accounts?: T[] } };
}

async function postGraphql<T>(accountId: string, token: string, query: string, variables: Record<string, unknown>): Promise<{ account: T | undefined }> {
	const response = await fetch(GRAPHQL_ENDPOINT, {
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

function requestsQuery(timeDimension: string, f: NonNullable<ResolvedFields["requests"]>): string {
	// A breakdown whose dimension does not exist is omitted entirely rather than queried against
	// a guessed name — the whole document fails on one unknown field, taking the series with it.
	const gatewayAlias = f.gateway
		? `
      byGateway: ${f.name}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        ${dimensionSelection([f.gateway])}
      }`
		: "";
	const modelAlias = f.model || f.provider
		? `
      byModel: ${f.name}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        ${dimensionSelection([f.model, f.provider])}
      }`
		: "";

	return `
query AiGatewayRequests($accountTag: string!, $since: Time!, $until: Time!, $seriesLimit: Int!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      series: ${f.name}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} }
        ${sumSelection([f.tokensIn, f.tokensOut])}
      }${gatewayAlias}${modelAlias}
    }
  }
}`;
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

function foldSeries(rows: RawRow[], timeDimension: string): AiGatewaySeriesPoint[] {
	const byTs = new Map<string, AiGatewaySeriesPoint>();
	for (const row of rows) {
		const ts = String(row.dimensions?.[timeDimension] ?? "");
		if (!ts) continue;
		const point = byTs.get(ts) ?? { ts, requests: 0 };
		point.requests += row.count;
		byTs.set(ts, point);
	}
	return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function foldBreakdown(rows: RawRow[], dimension: string): AiGatewayBreakdownRow[] {
	const byKey = new Map<string, AiGatewayBreakdownRow>();
	for (const row of rows) {
		const key = String(row.dimensions?.[dimension] ?? "").trim() || "(unknown)";
		const entry = byKey.get(key) ?? { key, requests: 0 };
		entry.requests += row.count;
		byKey.set(key, entry);
	}
	return [...byKey.values()].sort((a, b) => b.requests - a.requests);
}

export async function fetchAiGatewayUsage(
	accountId: string,
	token: string,
	options: { since: string; until: string; granularity: AiGatewayGranularity },
): Promise<AiGatewayUsageResult> {
	const timeDimension = TIME_DIMENSION[options.granularity];
	const variables = { since: options.since, until: options.until, seriesLimit: SERIES_LIMIT, breakdownLimit: BREAKDOWN_LIMIT };

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

	interface RequestsAccount {
		series?: RawRow[];
		byGateway?: RawRow[];
		byModel?: RawRow[];
	}
	const { account } = await postGraphql<RequestsAccount>(accountId, token, requestsQuery(timeDimension, fields.requests), variables);
	const seriesRows = account?.series || [];
	const series = foldSeries(seriesRows, timeDimension);
	const requests = series.reduce((sum, p) => sum + p.requests, 0);

	// A token field the schema does not expose stays null rather than summing to a confident 0.
	const sumOf = (field: string | null): number | null =>
		field ? seriesRows.reduce((total, row) => total + (row.sum?.[field] ?? 0), 0) : null;
	const tokensIn = sumOf(fields.requests.tokensIn);
	const tokensOut = sumOf(fields.requests.tokensOut);

	// The three supplementary datasets each degrade independently: an absent dataset (or a
	// dimension this account does not carry) empties that one panel with a stated reason instead
	// of taking the whole section down. Run them concurrently since none depends on another.
	const [errorsOutcome, cacheOutcome, spendOutcome] = await Promise.allSettled([
		fields.errors ? postGraphql<{ total?: RawRow[] }>(accountId, token, errorsQuery(fields.errors), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway errors dataset")),
		fields.cache ? postGraphql<{ byStatus?: RawRow[] }>(accountId, token, cacheQuery(fields.cache), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway cache dataset")),
		fields.spend ? postGraphql<{ total?: RawRow[] }>(accountId, token, spendQuery(fields.spend), variables) : Promise.reject(new Error("This account's schema exposes no AI Gateway spend dataset")),
	]);

	const reasonOf = (outcome: PromiseSettledResult<unknown>): string =>
		outcome.status === "rejected"
			? outcome.reason instanceof Error
				? outcome.reason.message
				: "Failed to load"
			: "";

	let errors: number | null = null;
	const errorsStatus: AiGatewayDatasetStatus = { available: false };
	if (errorsOutcome.status === "fulfilled") {
		errors = (errorsOutcome.value.account?.total || []).reduce((sum, row) => sum + row.count, 0);
		errorsStatus.available = true;
	} else {
		errorsStatus.reason = reasonOf(errorsOutcome);
	}

	let cacheHits: number | null = null;
	let cacheMisses: number | null = null;
	const cacheStatus: AiGatewayDatasetStatus = { available: false };
	if (cacheOutcome.status === "fulfilled" && fields.cache?.status) {
		const rows = cacheOutcome.value.account?.byStatus || [];
		cacheHits = 0;
		cacheMisses = 0;
		for (const row of rows) {
			if (isCacheHit(row.dimensions?.[fields.cache.status])) cacheHits += row.count;
			else cacheMisses += row.count;
		}
		cacheStatus.available = true;
	} else {
		// Present but with no status dimension is still unusable: hits and misses would be
		// indistinguishable, and reporting every row as a miss would invent a 0% hit rate.
		cacheStatus.reason = cacheOutcome.status === "fulfilled" ? "The cache dataset exposes no status dimension, so hits cannot be told from misses" : reasonOf(cacheOutcome);
	}

	let cost: number | null = null;
	const spendStatus: AiGatewayDatasetStatus = { available: false };
	if (spendOutcome.status === "fulfilled" && fields.spend?.cost) {
		const rows = spendOutcome.value.account?.total || [];
		// No rows stays null rather than 0: until this has been seen against real data, an empty
		// spend result cannot be told apart from a dataset that does not answer in this shape,
		// and a confident $0 is the more damaging of the two readings.
		if (rows.length) cost = rows.reduce((sum, row) => sum + (row.sum?.[fields.spend!.cost as string] ?? 0), 0);
		spendStatus.available = true;
	} else {
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
	};

	return {
		granularity: options.granularity,
		timeDimension,
		series,
		totals,
		byGateway: fields.requests.gateway ? foldBreakdown(account?.byGateway || [], fields.requests.gateway) : [],
		byModel: fields.requests.model ? foldBreakdown(account?.byModel || [], fields.requests.model) : [],
		truncated: seriesRows.length >= SERIES_LIMIT,
		datasets: { errors: errorsStatus, cache: cacheStatus, spend: spendStatus },
	};
}

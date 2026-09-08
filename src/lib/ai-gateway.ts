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
const FIELDS = {
	requests: {
		// HIGH — "aiGatewayXAdaptiveGroups" matches gatewayResolverQueriesAdaptiveGroups /
		// gatewayL7RequestsAdaptiveGroups / aiInferenceAdaptiveGroups exactly.
		dataset: "aiGatewayRequestsAdaptiveGroups",
		// MEDIUM — the AI Gateway dashboard is gateway-scoped, so *some* gateway identifier
		// dimension should exist; "gatewayId" mirrors "modelId" on aiInferenceAdaptiveGroups.
		// Could instead be "gatewayTag" or the gateway's slug under a different key.
		gatewayId: "gatewayId",
		// MEDIUM — mirrors modelId on aiInferenceAdaptiveGroups. AI Gateway's own Logpush
		// dataset names this field "model", so "model" (not "modelId") is used here instead.
		model: "model",
		// LOW — no precedent in this repo. AI Gateway proxies many providers per gateway, so a
		// provider dimension separate from the model string is likely but unconfirmed.
		provider: "provider",
		// LOW — Logpush's `tokens_in`/`tokens_out` are per-request scalars; whether the
		// Analytics API exposes their SUM under these exact names (vs. e.g. "totalTokensIn")
		// is unconfirmed. Named to match totalInputTokens/totalOutputTokens's "totalX" shape.
		sumTokensIn: "totalTokensIn",
		sumTokensOut: "totalTokensOut",
		// LOW — cost may not be exposed on the requests dataset at all, which is exactly why
		// aiGatewaySpendSessionsAdaptiveGroups exists as a separate, dedicated source below.
		// Attempted here too, opportunistically, since the task description allows for it
		// ("cost if exposed"); if the field or dataset name is wrong this alias just degrades.
		sumCost: "totalCost",
	},
	errors: {
		// HIGH — same dataset-naming convention as above.
		dataset: "aiGatewayErrorsAdaptiveGroups",
		// MEDIUM — mirrors errorCode on aiInferenceAdaptiveGroups, where 0 means "no error".
		// An errors-only dataset more plausibly has no zero bucket at all (every row IS an
		// error), so isError() below does not special-case a zero code the way workers-ai.ts
		// does — every row returned by this dataset counts.
		errorCode: "errorCode",
		// LOW — an HTTP status code dimension, if the dataset carries one.
		statusCode: "statusCode",
	},
	cache: {
		// HIGH — same dataset-naming convention.
		dataset: "aiGatewayCacheAdaptiveGroups",
		// LOW — AI Gateway's dashboard shows a HIT/MISS/DYNAMIC-style cache status; the
		// dimension holding it could be a string enum ("cacheStatus") or a boolean ("cached").
		// A string enum is assumed since that is what Cloudflare's own cache UIs use elsewhere
		// (cf-cache-status), and isCacheHit() below is written as a substring test for the same
		// reason isBlockedVerdict() is in gateway-usage.ts — an unfamiliar value must not be
		// silently miscounted.
		cacheStatus: "cacheStatus",
	},
	spend: {
		// HIGH — same dataset-naming convention.
		dataset: "aiGatewaySpendSessionsAdaptiveGroups",
		// LOW — "session" in the dataset name suggests this may be structured very differently
		// from the other three (e.g. one row per billing session rather than per request), so
		// even the aggregate field below is a guess about shape, not just name.
		sumCost: "totalCost",
	},
} as const;

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
	tokensIn: number;
	tokensOut: number;
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

function requestsQuery(timeDimension: string): string {
	const f = FIELDS.requests;
	return `
query AiGatewayRequests($accountTag: string!, $since: Time!, $until: Time!, $seriesLimit: Int!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      series: ${f.dataset}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} }
        sum { ${f.sumTokensIn} ${f.sumTokensOut} ${f.sumCost} }
      }
      byGateway: ${f.dataset}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { ${f.gatewayId} }
      }
      byModel: ${f.dataset}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { ${f.model} ${f.provider} }
      }
    }
  }
}`;
}

function errorsQuery(): string {
	const f = FIELDS.errors;
	return `
query AiGatewayErrors($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: ${f.dataset}(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $breakdownLimit) {
        count
      }
    }
  }
}`;
}

function cacheQuery(): string {
	const f = FIELDS.cache;
	return `
query AiGatewayCache($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      byStatus: ${f.dataset}(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { ${f.cacheStatus} }
      }
    }
  }
}`;
}

function spendQuery(): string {
	const f = FIELDS.spend;
	return `
query AiGatewaySpend($accountTag: string!, $since: Time!, $until: Time!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: ${f.dataset}(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $breakdownLimit) {
        sum { ${f.sumCost} }
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

	// The requests dataset is load-bearing: without it there is no series, no totals base, and
	// no breakdowns, so a failure here throws exactly like every other section's single fetch.
	interface RequestsAccount {
		series?: RawRow[];
		byGateway?: RawRow[];
		byModel?: RawRow[];
	}
	const { account } = await postGraphql<RequestsAccount>(accountId, token, requestsQuery(timeDimension), variables);
	const seriesRows = account?.series || [];
	const series = foldSeries(seriesRows, timeDimension);
	const requests = series.reduce((sum, p) => sum + p.requests, 0);
	const tokensIn = seriesRows.reduce((sum, row) => sum + (row.sum?.[FIELDS.requests.sumTokensIn] ?? 0), 0);
	const tokensOut = seriesRows.reduce((sum, row) => sum + (row.sum?.[FIELDS.requests.sumTokensOut] ?? 0), 0);
	const inlineCost = seriesRows.reduce((sum, row) => sum + (row.sum?.[FIELDS.requests.sumCost] ?? 0), 0);
	const inlineCostSeen = seriesRows.some((row) => row.sum?.[FIELDS.requests.sumCost] !== undefined);

	// The three supplementary datasets each degrade independently: a wrong field/dataset name
	// (or a genuinely absent scope) empties that one panel with a stated reason instead of
	// taking the whole section down. Run them concurrently since none depends on another.
	const [errorsOutcome, cacheOutcome, spendOutcome] = await Promise.allSettled([
		postGraphql<{ total?: RawRow[] }>(accountId, token, errorsQuery(), variables),
		postGraphql<{ byStatus?: RawRow[] }>(accountId, token, cacheQuery(), variables),
		postGraphql<{ total?: RawRow[] }>(accountId, token, spendQuery(), variables),
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
	if (cacheOutcome.status === "fulfilled") {
		const rows = cacheOutcome.value.account?.byStatus || [];
		cacheHits = 0;
		cacheMisses = 0;
		for (const row of rows) {
			if (isCacheHit(row.dimensions?.[FIELDS.cache.cacheStatus])) cacheHits += row.count;
			else cacheMisses += row.count;
		}
		cacheStatus.available = true;
	} else {
		cacheStatus.reason = reasonOf(cacheOutcome);
	}

	let cost: number | null = inlineCostSeen ? inlineCost : null;
	const spendStatus: AiGatewayDatasetStatus = { available: false };
	if (spendOutcome.status === "fulfilled") {
		const rows = spendOutcome.value.account?.total || [];
		if (rows.length) cost = rows.reduce((sum, row) => sum + (row.sum?.[FIELDS.spend.sumCost] ?? 0), 0);
		spendStatus.available = true;
	} else {
		spendStatus.reason = reasonOf(spendOutcome);
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
		byGateway: foldBreakdown(account?.byGateway || [], FIELDS.requests.gatewayId),
		byModel: foldBreakdown(account?.byModel || [], FIELDS.requests.model),
		truncated: seriesRows.length >= SERIES_LIMIT,
		datasets: { errors: errorsStatus, cache: cacheStatus, spend: spendStatus },
	};
}

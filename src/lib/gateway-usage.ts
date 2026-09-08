/**
 * Zero Trust Gateway usage: DNS resolver queries and Gateway HTTP requests.
 *
 * The app already audits how Access policies are *configured* and how they are *used*; this is
 * the other half of Zero Trust — what Gateway is actually filtering.
 *
 * Aggregate-only by the same rule as the Access Usage section: both datasets expose per-person
 * dimensions (`email`, `userId`, `deviceId`, source IPs) and none of them are queried. Under a
 * shared bound token those reads would not be attributable to a person anyway.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const GATEWAY_GRANULARITIES = ["hourly", "daily"] as const;
export type GatewayGranularity = (typeof GATEWAY_GRANULARITIES)[number];

const TIME_DIMENSION: Record<GatewayGranularity, string> = { hourly: "datetimeHour", daily: "date" };

const SERIES_LIMIT = 5_000;
const BREAKDOWN_LIMIT = 50;

export const MAX_GATEWAY_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export class GatewayUsageError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "GatewayUsageError";
	}
}

export function isGatewayGranularity(value: unknown): value is GatewayGranularity {
	return typeof value === "string" && (GATEWAY_GRANULARITIES as readonly string[]).includes(value);
}

interface RawRow {
	count: number;
	dimensions?: Record<string, string | string[] | number>;
}

export interface GatewayPoint {
	ts: string;
	allowed: number;
	blocked: number;
}

export interface GatewayBreakdownRow {
	key: string;
	allowed: number;
	blocked: number;
	total: number;
}

export interface GatewayUsageResult {
	granularity: GatewayGranularity;
	timeDimension: string;
	dns: {
		series: GatewayPoint[];
		totals: { allowed: number; blocked: number; total: number };
		byCategory: GatewayBreakdownRow[];
		byPolicy: GatewayBreakdownRow[];
	};
	http: {
		series: GatewayPoint[];
		totals: { allowed: number; blocked: number; total: number };
		byHost: GatewayBreakdownRow[];
		byAction: GatewayBreakdownRow[];
	};
	truncated: boolean;
}

/**
 * Both datasets describe the outcome as a free-text verdict rather than a boolean, so this is a
 * substring test: anything naming a block or a quarantine counts as blocked, everything else is
 * treated as allowed. A verdict we have not seen before is therefore never silently counted as
 * a block.
 *
 * Checked against Cloudflare's published policy vocabulary (2026-09-08), since no window queried
 * on this account has yet contained a real block:
 *
 *   HTTP policy `action`  allow, block, quarantine, isolate, off (Do Not Inspect), and the
 *                         non-enforcement actions. Of these only block and quarantine stop the
 *                         request, and both are matched here. `isolate` is deliberately NOT a
 *                         block: the request is served, through Browser Isolation.
 *   DNS `resolverDecision` camelCase strings naming what happened, e.g. `blockedOnBlockPolicy`,
 *                         `allowedOnNoPolicyMatch`, `overrideForSafeSearch`. The Block action's
 *                         decisions all carry "blocked".
 *
 * The Override, Safe Search and YouTube Restricted Mode actions rewrite the answer rather than
 * refusing it, so they land under allowed. That is the intended reading — the query did resolve —
 * but it does mean "allowed" here means "not blocked", not "unmodified".
 *
 * Exported for tests; production callers go through the folds below.
 */
export function isBlockedVerdict(value: unknown): boolean {
	const text = String(value ?? "").toLowerCase();
	return text.includes("block") || text.includes("quarantine");
}

/** Multi-value dimensions (categoryNames) arrive as arrays; one row can span several keys. */
function keysOf(value: string | string[] | number | undefined): string[] {
	if (Array.isArray(value)) return value.length ? value.map(String) : ["(uncategorised)"];
	const text = String(value ?? "").trim();
	return [text || "(none)"];
}

function foldSeries(rows: RawRow[], timeDimension: string, verdictField: string): GatewayPoint[] {
	const byTs = new Map<string, GatewayPoint>();
	for (const row of rows) {
		const ts = String(row.dimensions?.[timeDimension] ?? "");
		if (!ts) continue;
		const point = byTs.get(ts) ?? { ts, allowed: 0, blocked: 0 };
		if (isBlockedVerdict(row.dimensions?.[verdictField])) point.blocked += row.count;
		else point.allowed += row.count;
		byTs.set(ts, point);
	}
	return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function foldBreakdown(rows: RawRow[], dimension: string, verdictField: string): GatewayBreakdownRow[] {
	const byKey = new Map<string, GatewayBreakdownRow>();
	for (const row of rows) {
		const blocked = isBlockedVerdict(row.dimensions?.[verdictField]);
		for (const key of keysOf(row.dimensions?.[dimension])) {
			const entry = byKey.get(key) ?? { key, allowed: 0, blocked: 0, total: 0 };
			if (blocked) entry.blocked += row.count;
			else entry.allowed += row.count;
			entry.total += row.count;
			byKey.set(key, entry);
		}
	}
	return [...byKey.values()].sort((a, b) => b.total - a.total);
}

function totalsOf(series: GatewayPoint[]): { allowed: number; blocked: number; total: number } {
	return series.reduce(
		(acc, point) => ({
			allowed: acc.allowed + point.allowed,
			blocked: acc.blocked + point.blocked,
			total: acc.total + point.allowed + point.blocked,
		}),
		{ allowed: 0, blocked: 0, total: 0 },
	);
}

const query = (timeDimension: string) => `
query GatewayUsage($accountTag: string!, $since: Time!, $until: Time!, $seriesLimit: Int!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      dnsSeries: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} resolverDecision }
      }
      dnsByCategory: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { categoryNames resolverDecision }
      }
      dnsByPolicy: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { policyName resolverDecision }
      }
      httpSeries: gatewayL7RequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} action }
      }
      httpByHost: gatewayL7RequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { httpHost action }
      }
      httpByAction: gatewayL7RequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { action }
      }
    }
  }
}`;

interface GraphqlEnvelope {
	errors?: { message?: string }[];
	data?: {
		viewer?: {
			accounts?: {
				dnsSeries?: RawRow[];
				dnsByCategory?: RawRow[];
				dnsByPolicy?: RawRow[];
				httpSeries?: RawRow[];
				httpByHost?: RawRow[];
				httpByAction?: RawRow[];
			}[];
		};
	};
}

export async function fetchGatewayUsage(
	accountId: string,
	token: string,
	options: { since: string; until: string; granularity: GatewayGranularity },
): Promise<GatewayUsageResult> {
	const timeDimension = TIME_DIMENSION[options.granularity];
	const response = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			query: query(timeDimension),
			variables: {
				accountTag: accountId,
				since: options.since,
				until: options.until,
				seriesLimit: SERIES_LIMIT,
				breakdownLimit: BREAKDOWN_LIMIT,
			},
		}),
	});

	if (response.status === 401 || response.status === 403) {
		throw new GatewayUsageError("Cloudflare API request failed", response.status);
	}
	let envelope: GraphqlEnvelope;
	try {
		envelope = await response.json();
	} catch {
		throw new GatewayUsageError("Cloudflare GraphQL returned a non-JSON response", 502);
	}
	if (envelope.errors?.length) {
		throw new GatewayUsageError(envelope.errors[0]?.message || "GraphQL query failed", 502);
	}

	const account = envelope.data?.viewer?.accounts?.[0];
	const dnsSeries = foldSeries(account?.dnsSeries || [], timeDimension, "resolverDecision");
	const httpSeries = foldSeries(account?.httpSeries || [], timeDimension, "action");

	return {
		granularity: options.granularity,
		timeDimension,
		dns: {
			series: dnsSeries,
			totals: totalsOf(dnsSeries),
			byCategory: foldBreakdown(account?.dnsByCategory || [], "categoryNames", "resolverDecision"),
			byPolicy: foldBreakdown(account?.dnsByPolicy || [], "policyName", "resolverDecision"),
		},
		http: {
			series: httpSeries,
			totals: totalsOf(httpSeries),
			byHost: foldBreakdown(account?.httpByHost || [], "httpHost", "action"),
			byAction: foldBreakdown(account?.httpByAction || [], "action", "action"),
		},
		truncated: (account?.dnsSeries?.length ?? 0) >= SERIES_LIMIT || (account?.httpSeries?.length ?? 0) >= SERIES_LIMIT,
	};
}

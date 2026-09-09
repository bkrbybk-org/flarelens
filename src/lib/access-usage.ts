/**
 * Cloudflare Access login telemetry: who is reaching Access-protected apps, through which
 * identity provider, from where, and how often that login is refused.
 *
 * Complements the Access sections already in the app, which describe how policies are
 * *configured*. This one describes how they are actually being *used* — a policy that looks
 * correct and a policy people can actually get through are different questions.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const ACCESS_GRANULARITIES = ["hourly", "daily"] as const;
export type AccessGranularity = (typeof ACCESS_GRANULARITIES)[number];

const TIME_DIMENSION: Record<AccessGranularity, string> = {
	hourly: "datetimeHour",
	daily: "date",
};

/** Per-alias row caps. The series needs depth; the breakdowns are top-N lists. */
const SERIES_LIMIT = 10_000;
const BREAKDOWN_LIMIT = 100;

/**
 * One week — not a choice, a hard upstream limit. A wider window is refused by Cloudflare with
 * `cannot request a time range wider than 1w`, so this section cannot offer the 30-day preset
 * the Workers and AI Security sections do. Enforced here to give a 400 with a readable message
 * instead of forwarding the query and surfacing a 502.
 */
export const MAX_ACCESS_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

export class AccessUsageError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "AccessUsageError";
	}
}

export function isAccessGranularity(value: unknown): value is AccessGranularity {
	return typeof value === "string" && (ACCESS_GRANULARITIES as readonly string[]).includes(value);
}

interface SeriesRow {
	count: number;
	/** Values arrive as strings, booleans or 0/1 depending on the dimension and schema version. */
	dimensions: Record<string, string | boolean | number>;
}

export interface AccessUsagePoint {
	ts: string;
	success: number;
	failure: number;
}

export interface AccessBreakdownRow {
	key: string;
	/** Present on the per-application breakdown only: the raw uuid behind `key`. */
	appId?: string;
	success: number;
	failure: number;
	total: number;
}

export interface AccessUsageResult {
	granularity: AccessGranularity;
	timeDimension: string;
	series: AccessUsagePoint[];
	byApp: AccessBreakdownRow[];
	byIdentityProvider: AccessBreakdownRow[];
	byCountry: AccessBreakdownRow[];
	totals: { success: number; failure: number; total: number };
	truncated: boolean;
}

const query = (timeDimension: string) => `
query AccessUsage($accountTag: string!, $since: Time!, $until: Time!, $seriesLimit: Int!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      series: accessLoginRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} isSuccessfulLogin }
      }
      byApp: accessLoginRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { appId isSuccessfulLogin }
      }
      byIdp: accessLoginRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { identityProvider isSuccessfulLogin }
      }
      byCountry: accessLoginRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { country isSuccessfulLogin }
      }
    }
  }
}`;

interface GraphqlEnvelope {
	errors?: { message?: string }[];
	data?: {
		viewer?: {
			accounts?: {
				series?: SeriesRow[];
				byApp?: SeriesRow[];
				byIdp?: SeriesRow[];
				byCountry?: SeriesRow[];
			}[];
		};
	};
}

/**
 * `isSuccessfulLogin` comes back as a boolean on some schema versions and as 0/1 or "true" on
 * others depending on how the dimension is projected. Normalise once here rather than guessing
 * at three call sites.
 */
function isSuccess(value: string | boolean | number | undefined): boolean {
	return value === true || value === 1 || value === "true" || value === "1";
}

/** Collapse success/failure rows for one dimension into a single row per key. */
function foldBreakdown(rows: SeriesRow[], dimension: string): AccessBreakdownRow[] {
	const byKey = new Map<string, AccessBreakdownRow>();
	for (const row of rows) {
		const raw = row.dimensions?.[dimension];
		// An empty dimension is real data (an app that was deleted, a country Cloudflare could
		// not resolve); label it rather than dropping the count out of the totals.
		const key = raw === undefined || raw === null || raw === "" ? "(unknown)" : String(raw);
		const entry = byKey.get(key) ?? { key, success: 0, failure: 0, total: 0 };
		if (isSuccess(row.dimensions?.isSuccessfulLogin)) entry.success += row.count;
		else entry.failure += row.count;
		entry.total += row.count;
		byKey.set(key, entry);
	}
	return [...byKey.values()].sort((a, b) => b.total - a.total);
}

function foldSeries(rows: SeriesRow[], timeDimension: string): AccessUsagePoint[] {
	const byTs = new Map<string, AccessUsagePoint>();
	for (const row of rows) {
		const ts = String(row.dimensions?.[timeDimension] ?? "");
		if (!ts) continue;
		const point = byTs.get(ts) ?? { ts, success: 0, failure: 0 };
		if (isSuccess(row.dimensions?.isSuccessfulLogin)) point.success += row.count;
		else point.failure += row.count;
		byTs.set(ts, point);
	}
	return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function fetchAccessUsage(
	accountId: string,
	token: string,
	options: {
		since: string;
		until: string;
		granularity: AccessGranularity;
		/** uuid -> display name, so the breakdowns are readable. Optional: ids render raw. */
		appNames?: Record<string, string>;
		idpNames?: Record<string, string>;
	},
): Promise<AccessUsageResult> {
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
		throw new AccessUsageError("Cloudflare API request failed", response.status);
	}
	let envelope: GraphqlEnvelope;
	try {
		envelope = await response.json();
	} catch {
		throw new AccessUsageError("Cloudflare GraphQL returned a non-JSON response", 502);
	}
	if (envelope.errors?.length) {
		throw new AccessUsageError(envelope.errors[0]?.message || "GraphQL query failed", 502);
	}

	const account = envelope.data?.viewer?.accounts?.[0];
	const seriesRows = account?.series || [];
	const series = foldSeries(seriesRows, timeDimension);
	const totals = series.reduce(
		(acc, point) => ({
			success: acc.success + point.success,
			failure: acc.failure + point.failure,
			total: acc.total + point.success + point.failure,
		}),
		{ success: 0, failure: 0, total: 0 },
	);

	// The dataset identifies apps and identity providers by uuid only, so the readable names
	// come from the Access REST lists the caller already has. An id with no match is kept and
	// shown as the raw uuid — usually an app that has since been deleted, which is worth seeing
	// rather than silently dropping from the totals.
	const label = (id: string, names: Record<string, string> | undefined) => names?.[id] ?? id;

	return {
		granularity: options.granularity,
		timeDimension,
		series,
		// `appId` is kept alongside the readable key: a caller joining this back onto the
		// application list must match on the uuid, not on a name that may be duplicated,
		// renamed, or absent for a deleted app.
		byApp: foldBreakdown(account?.byApp || [], "appId").map((row) => ({
			...row,
			appId: row.key,
			key: row.key === "(unknown)" ? row.key : label(row.key, options.appNames),
		})),
		byIdentityProvider: foldBreakdown(account?.byIdp || [], "identityProvider").map((row) => ({
			...row,
			key: row.key === "(unknown)" ? row.key : label(row.key, options.idpNames),
		})),
		byCountry: foldBreakdown(account?.byCountry || [], "country"),
		totals,
		truncated: seriesRows.length >= SERIES_LIMIT,
	};
}

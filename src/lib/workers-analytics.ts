/**
 * Workers invocation analytics: per-script requests, errors, subrequests and CPU time.
 *
 * Ported by observation from a colleague's standalone "Workers Analytics Dashboard" Worker,
 * whose source was not available — the wire shapes here match what that deployment returns, so
 * a record from either backend renders identically.
 */

const REST_BASE = "https://api.cloudflare.com/client/v4";
const GRAPHQL_ENDPOINT = `${REST_BASE}/graphql`;

/** Matches the upstream dashboard: hourly buckets, or daily for long ranges. */
export const GRANULARITIES = ["hourly", "daily"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** GraphQL time dimension for each granularity. Also reported back so the client can label. */
const TIME_DIMENSION: Record<Granularity, string> = {
	hourly: "datetimeHour",
	daily: "date",
};

/**
 * The upstream dataset caps a query at 10k rows. Requesting exactly that many lets the caller
 * be told the result was truncated rather than silently reading a partial window as if it were
 * the whole thing.
 */
export const ROW_LIMIT = 10_000;

/** 30 days, matching the longest preset the upstream dashboard offers. */
export const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorkerMetricRecord {
	dimensions: { scriptName: string } & Record<string, string>;
	sum: { requests: number; errors: number; subrequests: number };
	quantiles: { cpuTimeP50: number | null };
}

export interface WorkerMetricsResult {
	data: WorkerMetricRecord[];
	granularity: Granularity;
	timeDimension: string;
	truncated: boolean;
}

export class WorkersAnalyticsError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "WorkersAnalyticsError";
	}
}

export function isGranularity(value: unknown): value is Granularity {
	return typeof value === "string" && (GRANULARITIES as readonly string[]).includes(value);
}

/**
 * Accept only a full ISO-8601 instant in UTC.
 *
 * The value is interpolated into a GraphQL document, so like the AI Security window code this
 * is the boundary that keeps caller text out of the query: anything that parses is re-emitted
 * through toISOString(), and anything else is refused.
 */
export function parseInstant(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 40) return null;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?Z$/.test(raw)) return null;
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Script names deployed on the account, sorted for a stable colour assignment client-side. */
export async function listWorkerScripts(accountId: string, token: string): Promise<string[]> {
	const response = await fetch(`${REST_BASE}/accounts/${accountId}/workers/scripts`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});
	let body: { success?: boolean; result?: { id?: string }[]; errors?: { message?: string }[] };
	try {
		body = await response.json();
	} catch {
		throw new WorkersAnalyticsError("Cloudflare returned a non-JSON response for the script list", 502);
	}
	if (!response.ok || !body.success) {
		const message = body.errors?.[0]?.message || "Failed to list Workers scripts";
		// 401/403 must survive: the client treats them as an expired session.
		throw new WorkersAnalyticsError(message, response.status === 401 || response.status === 403 ? response.status : 502);
	}
	return (body.result || []).map((script) => script.id || "").filter(Boolean).sort();
}

const metricsQuery = (timeDimension: string) => `
query WorkersMetrics($accountTag: string!, $since: Time!, $until: Time!, $limit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $limit
        orderBy: [${timeDimension}_ASC]
      ) {
        dimensions {
          ${timeDimension}
          scriptName
        }
        sum {
          requests
          errors
          subrequests
        }
        quantiles {
          cpuTimeP50
        }
      }
    }
  }
}`;

interface GraphqlEnvelope {
	errors?: { message?: string }[];
	data?: {
		viewer?: {
			accounts?: { workersInvocationsAdaptive?: WorkerMetricRecord[] }[];
		};
	};
}

export async function fetchWorkerMetrics(
	accountId: string,
	token: string,
	options: { since: string; until: string; granularity: Granularity },
): Promise<WorkerMetricsResult> {
	const timeDimension = TIME_DIMENSION[options.granularity];
	const response = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			query: metricsQuery(timeDimension),
			variables: { accountTag: accountId, since: options.since, until: options.until, limit: ROW_LIMIT },
		}),
	});

	if (response.status === 401 || response.status === 403) {
		throw new WorkersAnalyticsError("Cloudflare API request failed", response.status);
	}
	let envelope: GraphqlEnvelope;
	try {
		envelope = await response.json();
	} catch {
		throw new WorkersAnalyticsError("Cloudflare GraphQL returned a non-JSON response", 502);
	}
	if (envelope.errors?.length) {
		throw new WorkersAnalyticsError(envelope.errors[0]?.message || "GraphQL query failed", 502);
	}

	const rows = envelope.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
	return {
		data: rows,
		granularity: options.granularity,
		timeDimension,
		// Exactly at the cap means rows were almost certainly dropped; say so rather than let a
		// partial window read as a complete one.
		truncated: rows.length >= ROW_LIMIT,
	};
}

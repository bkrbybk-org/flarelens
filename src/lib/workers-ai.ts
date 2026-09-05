/**
 * Workers AI inference analytics: what the account is running on Workers AI, how much it costs
 * in neurons, and how it is performing.
 *
 * Distinct from the AI Security section, which is about detections on LLM traffic passing
 * through Cloudflare. This one is about the account's own inference workloads.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const AI_GRANULARITIES = ["hourly", "daily"] as const;
export type AiGranularity = (typeof AI_GRANULARITIES)[number];

const TIME_DIMENSION: Record<AiGranularity, string> = { hourly: "datetimeHour", daily: "date" };

const SERIES_LIMIT = 10_000;
const BREAKDOWN_LIMIT = 100;

/** 30 days. Narrowed automatically if Cloudflare refuses the width, as it does for Access. */
export const MAX_AI_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export class WorkersAiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "WorkersAiError";
	}
}

export function isAiGranularity(value: unknown): value is AiGranularity {
	return typeof value === "string" && (AI_GRANULARITIES as readonly string[]).includes(value);
}

interface RawRow {
	count: number;
	dimensions?: Record<string, string | number>;
	sum?: Record<string, number>;
}

export interface AiTotals {
	requests: number;
	neurons: number;
	inputTokens: number;
	outputTokens: number;
	inferenceTimeMs: number;
	errors: number;
}

export interface AiSeriesPoint extends AiTotals {
	ts: string;
}

export interface AiModelRow extends AiTotals {
	modelId: string;
	/** Mean inference time per request, in ms; null when nothing was recorded. */
	avgLatencyMs: number | null;
}

export interface AiBreakdownRow {
	key: string;
	requests: number;
	neurons: number;
}

export interface WorkersAiResult {
	granularity: AiGranularity;
	timeDimension: string;
	series: AiSeriesPoint[];
	byModel: AiModelRow[];
	bySource: AiBreakdownRow[];
	errorsByCode: { code: string; requests: number }[];
	totals: AiTotals;
	truncated: boolean;
}

const SUM_FIELDS = `totalNeurons totalInputTokens totalOutputTokens totalInferenceTimeMs`;

const query = (timeDimension: string) => `
query WorkersAi($accountTag: string!, $since: Time!, $until: Time!, $seriesLimit: Int!, $breakdownLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      series: aiInferenceAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $seriesLimit
        orderBy: [${timeDimension}_ASC]
      ) {
        count
        dimensions { ${timeDimension} errorCode }
        sum { ${SUM_FIELDS} }
      }
      byModel: aiInferenceAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { modelId errorCode }
        sum { ${SUM_FIELDS} }
      }
      bySource: aiInferenceAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestSource }
        sum { totalNeurons }
      }
      byError: aiInferenceAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $breakdownLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { errorCode }
      }
    }
  }
}`;

interface GraphqlEnvelope {
	errors?: { message?: string }[];
	data?: {
		viewer?: {
			accounts?: { series?: RawRow[]; byModel?: RawRow[]; bySource?: RawRow[]; byError?: RawRow[] }[];
		};
	};
}

function emptyTotals(): AiTotals {
	return { requests: 0, neurons: 0, inputTokens: 0, outputTokens: 0, inferenceTimeMs: 0, errors: 0 };
}

/** errorCode 0 is "no error"; anything else is a failed inference. */
function isError(row: RawRow): boolean {
	const code = row.dimensions?.errorCode;
	return code !== undefined && Number(code) !== 0;
}

function addRow(totals: AiTotals, row: RawRow): void {
	totals.requests += row.count;
	totals.neurons += row.sum?.totalNeurons ?? 0;
	totals.inputTokens += row.sum?.totalInputTokens ?? 0;
	totals.outputTokens += row.sum?.totalOutputTokens ?? 0;
	totals.inferenceTimeMs += row.sum?.totalInferenceTimeMs ?? 0;
	if (isError(row)) totals.errors += row.count;
}

export async function fetchWorkersAi(
	accountId: string,
	token: string,
	options: { since: string; until: string; granularity: AiGranularity },
): Promise<WorkersAiResult> {
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
		throw new WorkersAiError("Cloudflare API request failed", response.status);
	}
	let envelope: GraphqlEnvelope;
	try {
		envelope = await response.json();
	} catch {
		throw new WorkersAiError("Cloudflare GraphQL returned a non-JSON response", 502);
	}
	if (envelope.errors?.length) {
		throw new WorkersAiError(envelope.errors[0]?.message || "GraphQL query failed", 502);
	}

	const account = envelope.data?.viewer?.accounts?.[0];
	const seriesRows = account?.series || [];

	// Rows arrive split by errorCode, so every bucket and model needs folding back together.
	const byTs = new Map<string, AiSeriesPoint>();
	for (const row of seriesRows) {
		const ts = String(row.dimensions?.[timeDimension] ?? "");
		if (!ts) continue;
		const point = byTs.get(ts) ?? { ts, ...emptyTotals() };
		addRow(point, row);
		byTs.set(ts, point);
	}
	const series = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));

	const byModelMap = new Map<string, AiModelRow>();
	for (const row of account?.byModel || []) {
		const modelId = String(row.dimensions?.modelId ?? "") || "(unknown)";
		const entry = byModelMap.get(modelId) ?? { modelId, avgLatencyMs: null, ...emptyTotals() };
		addRow(entry, row);
		byModelMap.set(modelId, entry);
	}
	const byModel = [...byModelMap.values()]
		.map((row) => ({ ...row, avgLatencyMs: row.requests ? row.inferenceTimeMs / row.requests : null }))
		.sort((a, b) => b.requests - a.requests);

	const bySourceMap = new Map<string, AiBreakdownRow>();
	for (const row of account?.bySource || []) {
		const key = String(row.dimensions?.requestSource ?? "") || "(unknown)";
		const entry = bySourceMap.get(key) ?? { key, requests: 0, neurons: 0 };
		entry.requests += row.count;
		entry.neurons += row.sum?.totalNeurons ?? 0;
		bySourceMap.set(key, entry);
	}

	const errorsByCode = (account?.byError || [])
		.filter(isError)
		.map((row) => ({ code: String(row.dimensions?.errorCode), requests: row.count }))
		.sort((a, b) => b.requests - a.requests);

	const totals = series.reduce((acc, point) => {
		acc.requests += point.requests;
		acc.neurons += point.neurons;
		acc.inputTokens += point.inputTokens;
		acc.outputTokens += point.outputTokens;
		acc.inferenceTimeMs += point.inferenceTimeMs;
		acc.errors += point.errors;
		return acc;
	}, emptyTotals());

	return {
		granularity: options.granularity,
		timeDimension,
		series,
		byModel,
		bySource: [...bySourceMap.values()].sort((a, b) => b.requests - a.requests),
		errorsByCode,
		totals,
		truncated: seriesRows.length >= SERIES_LIMIT,
	};
}

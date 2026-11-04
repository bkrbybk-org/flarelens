export type AiGatewayGranularity = "hourly" | "daily";

/** Mirrors src/lib/ai-gateway.ts. A null measure means the schema has no such field — never 0. */
export interface AiGatewaySeriesPoint {
	ts: string;
	requests: number;
	tokens: number | null;
	cost: number | null;
	errors: number | null;
}

export interface AiGatewayBreakdownRow {
	key: string;
	requests: number;
	tokensIn: number | null;
	tokensOut: number | null;
	cost: number | null;
	errors: number | null;
	cached: number | null;
	p50: number | null;
	p95: number | null;
}

export interface AiGatewayStatusRow {
	statusCode: string;
	rateLimited: boolean;
	requests: number;
}

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
}

export interface AiGatewayFilter {
	gateway?: string;
	provider?: string;
	model?: string;
}

/** Mirrors src/lib/ai-gateway.ts's AiGatewayDatasetStatus: a degraded panel carries why. */
export interface AiGatewayDatasetStatus {
	available: boolean;
	reason?: string;
}

export interface AiGatewayTotals {
	requests: number;
	tokensIn: number | null;
	tokensOut: number | null;
	cost: number | null;
	errors: number | null;
	errorRate: number | null;
	cacheHits: number | null;
	cacheMisses: number | null;
	cacheHitRate: number | null;
	p50: number | null;
	p95: number | null;
	rateLimited: number | null;
}

export interface AiGatewayPrevious {
	requests: number;
	tokens: number | null;
	cost: number | null;
	errorRate: number | null;
	cacheHitRate: number | null;
	p50: number | null;
}

export interface AiGatewayUsageResult {
	granularity: AiGatewayGranularity;
	timeDimension: string;
	series: AiGatewaySeriesPoint[];
	totals: AiGatewayTotals;
	byGateway: AiGatewayBreakdownRow[];
	byProvider: AiGatewayBreakdownRow[];
	byModel: AiGatewayBreakdownRow[];
	byStatus: AiGatewayStatusRow[];
	recent: AiGatewayRequestRow[];
	previous: AiGatewayPrevious | null;
	previousWindow: { since: string; until: string };
	filter: AiGatewayFilter;
	truncated: boolean;
	datasets: { errors: AiGatewayDatasetStatus; cache: AiGatewayDatasetStatus; spend: AiGatewayDatasetStatus };
}

export const EMPTY_TOTALS: AiGatewayTotals = {
	requests: 0,
	tokensIn: null,
	tokensOut: null,
	cost: null,
	errors: null,
	errorRate: null,
	cacheHits: null,
	cacheMisses: null,
	cacheHitRate: null,
	p50: null,
	p95: null,
	rateLimited: null,
};

export function compactCount(value: number | null): string {
	if (value === null) return "—";
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return value.toLocaleString();
}

/** A null rate is "no data" (denominator was 0, or the dataset failed) — never rendered as 0%. */
export function formatRate(rate: number | null): string {
	return rate === null ? "—" : `${(rate * 100).toFixed(rate > 0 && rate < 0.001 ? 3 : 1)}%`;
}

/** Small amounts keep enough digits to be told apart from zero; a per-request cost is often under a cent. */
export function formatCost(cost: number | null): string {
	if (cost === null) return "—";
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toPrecision(2)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * Change against the previous window, as a fraction. null when there is nothing to compare —
 * no previous value, or a previous zero (a rise from nothing has no percentage).
 */
export function change(current: number | null, previous: number | null | undefined): number | null {
	if (current === null || previous === null || previous === undefined || previous === 0) return null;
	return (current - previous) / previous;
}

export function aiGatewayBucketLabel(ts: string, granularity: AiGatewayGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
}

/** The slice's name, outermost first: what the breadcrumb shows. */
export const FILTER_ORDER: (keyof AiGatewayFilter)[] = ["gateway", "provider", "model"];

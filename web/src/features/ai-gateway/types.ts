export type AiGatewayGranularity = "hourly" | "daily";

export interface AiGatewaySeriesPoint {
	ts: string;
	requests: number;
}

export interface AiGatewayBreakdownRow {
	key: string;
	requests: number;
}

/** Mirrors src/lib/ai-gateway.ts's AiGatewayDatasetStatus: a degraded panel carries why. */
export interface AiGatewayDatasetStatus {
	available: boolean;
	reason?: string;
}

export interface AiGatewayTotals {
	requests: number;
	tokensIn: number;
	tokensOut: number;
	cost: number | null;
	errors: number | null;
	errorRate: number | null;
	cacheHits: number | null;
	cacheMisses: number | null;
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
	datasets: { errors: AiGatewayDatasetStatus; cache: AiGatewayDatasetStatus; spend: AiGatewayDatasetStatus };
}

export const EMPTY_TOTALS: AiGatewayTotals = {
	requests: 0,
	tokensIn: 0,
	tokensOut: 0,
	cost: null,
	errors: null,
	errorRate: null,
	cacheHits: null,
	cacheMisses: null,
	cacheHitRate: null,
};

export function compactCount(value: number): string {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return value.toLocaleString();
}

/** A null rate is "no data" (denominator was 0, or the dataset failed) — never rendered as 0%. */
export function formatRate(rate: number | null): string {
	return rate === null ? "—" : `${(rate * 100).toFixed(2)}%`;
}

export function formatCost(cost: number | null): string {
	return cost === null ? "—" : `$${cost.toFixed(2)}`;
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

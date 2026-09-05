export const AI_PRESETS = {
	"24h": { label: "24h", ms: 24 * 3_600_000 },
	"7d": { label: "7d", ms: 7 * 86_400_000 },
	"30d": { label: "30d", ms: 30 * 86_400_000 },
} as const;

export type AiPreset = keyof typeof AI_PRESETS;
export type AiGranularity = "hourly" | "daily";

export const AI_METRICS = {
	requests: "Requests",
	neurons: "Neurons",
	tokens: "Tokens",
	errors: "Errors",
} as const;

export type AiMetric = keyof typeof AI_METRICS;

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
	avgLatencyMs: number | null;
}

export interface WorkersAiResult {
	granularity: AiGranularity;
	timeDimension: string;
	series: AiSeriesPoint[];
	byModel: AiModelRow[];
	bySource: { key: string; requests: number; neurons: number }[];
	errorsByCode: { code: string; requests: number }[];
	totals: AiTotals;
	truncated: boolean;
}

export function metricOf(point: AiTotals, metric: AiMetric): number {
	switch (metric) {
		case "requests":
			return point.requests;
		case "neurons":
			return point.neurons;
		case "tokens":
			return point.inputTokens + point.outputTokens;
		case "errors":
			return point.errors;
	}
}

export function formatCompact(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	// Neurons are fractional and small; a bare rounded integer would read as zero usage.
	return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

export function formatLatency(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "—";
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${Math.round(ms)} ms`;
}

/** Strip the `@cf/vendor/` prefix so the table reads as model names, full id kept in a title. */
export function shortModel(modelId: string): string {
	const parts = modelId.split("/");
	return parts.length > 1 ? parts[parts.length - 1] : modelId;
}

export function aiBucketLabel(ts: string, granularity: AiGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
}

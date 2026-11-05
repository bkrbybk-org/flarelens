export type AiGatewayGranularity = "15m" | "hourly" | "daily";

/** Buckets that suit the window: a short window in 15 minutes, a day in hours, longer by day. */
export function granularityFor(minutes: number): AiGatewayGranularity {
	if (minutes <= 360) return "15m";
	if (minutes <= 1440) return "hourly";
	return "daily";
}

export const GRANULARITY_LABEL: Record<AiGatewayGranularity, string> = { "15m": "15-minute", hourly: "Hourly", daily: "Daily" };

/** One bucket's share for one gateway, model or provider. */
export interface AiGatewaySplitPoint {
	ts: string;
	key: string;
	requests: number;
	tokens: number | null;
	cost: number | null;
	errors: number | null;
}

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
	/** The `user` tag's value, or "" when the request carries none. */
	user: string;
}

export interface AiGatewayFilter {
	gateway?: string;
	provider?: string;
	model?: string;
	/** One value of the `user` metadata tag (an email address). */
	user?: string;
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
	users: number | null;
	sessions: number | null;
	promptCache: { readTokens: number; inputTokens: number; requestsWithRead: number | null } | null;
}

/** Mirrors src/lib/ai-gateway.ts. Values are masked by the Worker (emails to their domain). */
export interface AiGatewayTags {
	keys: { key: string; requests: number; sensitive: boolean }[];
	selected: string | null;
	rows: AiGatewayBreakdownRow[];
	series: AiGatewaySplitPoint[];
}

export const SESSION_FLAG_LABEL = {
	abnormalCost: "Unusually expensive",
	abnormalDuration: "Unusually long",
	lowCacheHit: "Low prompt-cache reuse",
	highFirstContext: "Very large first prompt",
	highMcpTools: "Heavy MCP tool use",
	premiumModel: "Used a premium model",
	thinkingModel: "Used a thinking model",
} as const;
export type SessionFlag = keyof typeof SESSION_FLAG_LABEL;

export type AiGatewaySessionHealth =
	| { available: true; sessions: number; flags: Record<SessionFlag, number | null>; basis: "all" | "primary" }
	| { available: false; reason: string };

export interface AiGatewayPrevious {
	requests: number;
	sessions: number | null;
	tokens: number | null;
	cost: number | null;
	errorRate: number | null;
	cacheHitRate: number | null;
	p50: number | null;
}

export interface AiGatewayFlow {
	user: string;
	gateway: string;
	model: string;
	requests: number;
	tokens: number | null;
	cost: number | null;
}

export interface AiGatewayUsageResult {
	granularity: AiGatewayGranularity;
	timeDimension: string;
	series: AiGatewaySeriesPoint[];
	seriesBy: { gateway: AiGatewaySplitPoint[]; model: AiGatewaySplitPoint[]; provider: AiGatewaySplitPoint[]; client: AiGatewaySplitPoint[]; user: AiGatewaySplitPoint[] };
	totals: AiGatewayTotals;
	byGateway: AiGatewayBreakdownRow[];
	byProvider: AiGatewayBreakdownRow[];
	byModel: AiGatewayBreakdownRow[];
	byStatus: AiGatewayStatusRow[];
	byClient: AiGatewayBreakdownRow[];
	sessionHealth: AiGatewaySessionHealth;
	/** Spend by custom metadata tag; null when the schema carries no metadata. */
	tags: AiGatewayTags | null;
	/** Per value of the `user` tag, shown as sent (full email addresses), plus "(not tagged)". null without metadata. */
	byUser: AiGatewayBreakdownRow[] | null;
	/** One row per user → gateway → model path, busiest first, "(not tagged)" for the rest. null without metadata. */
	flows: AiGatewayFlow[] | null;
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
	users: null,
	sessions: null,
	promptCache: null,
};

/** Provider ids as AI Gateway records them, in the names people know them by. Unknown ids show as they are. */
const PROVIDER_NAMES: Record<string, string> = {
	"workers-ai": "Workers AI",
	openai: "OpenAI",
	anthropic: "Anthropic",
	"google-ai-studio": "Google AI Studio",
	"google-vertex-ai": "Google Vertex AI",
	"azure-openai": "Azure OpenAI",
	"aws-bedrock": "Amazon Bedrock",
	groq: "Groq",
	mistral: "Mistral",
	cohere: "Cohere",
	deepseek: "DeepSeek",
	"perplexity-ai": "Perplexity",
	openrouter: "OpenRouter",
	grok: "xAI",
	huggingface: "Hugging Face",
	replicate: "Replicate",
	cerebras: "Cerebras",
	cartesia: "Cartesia",
	elevenlabs: "ElevenLabs",
	deepgram: "Deepgram",
	"fal-ai": "fal",
	ideogram: "Ideogram",
};

export function providerName(id: string): string {
	return PROVIDER_NAMES[id] ?? id;
}

/** Days in the window with any request, and the window's length in days. */
export function activeDays(series: { ts: string; requests: number }[], windowDays: number): { active: number; of: number } {
	const days = new Set(series.filter((p) => p.requests > 0).map((p) => p.ts.slice(0, 10)));
	return { active: days.size, of: Math.max(windowDays, days.size) };
}

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
export const FILTER_ORDER: (keyof AiGatewayFilter)[] = ["gateway", "provider", "model", "user"];

/** Rows that stand for no single name: nothing to drill into. */
export const UNDRILLABLE = new Set(["(unknown)", "(not tagged)", "(empty)"]);

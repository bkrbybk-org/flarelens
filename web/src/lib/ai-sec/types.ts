/**
 * The AI Security wire contract, declared once and compiled by both sides.
 *
 * It lives under web/ and is pulled into the worker's tsconfig the same way web/src/lib/expr.ts
 * already is. That direction is deliberate: the worker's domain layer keeps its own internal
 * types (they carry things the browser never sees), and src/lib/ai-sec/index.ts declares its
 * return type as the `AiSecResult` below — so if the aggregation stops producing a field the UI
 * reads, the worker fails to compile rather than the client silently rendering undefined.
 *
 * Flarelens's other features redeclare their shapes per side (see web/src/lib/waf/types.ts).
 * That works for FirewallEvent, which is eight fields; Dashboard is thirty-odd across a dozen
 * nested rows, and a hand-kept copy of it would have drifted the first time a breakdown changed.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type SessionKey = "ip" | "ja4" | "asn";
export type DetectionType = "all" | "injection" | "pii" | "unsafe" | "custom";
export type RangeKey = "30m" | "1h" | "3h" | "6h" | "12h" | "24h" | "7d" | "30d";

export interface TimeWindow {
	key: RangeKey | "custom";
	label: string;
	/** Bucketing dimension for the time series. */
	bucket: string;
	start: string;
	end: string;
	/** Same-length window immediately before `start`, for period-over-period deltas. */
	prevStart: string;
	prevEnd: string;
}

export interface CountItem {
	key: string;
	label: string;
	count: number;
	tone?: string;
	href?: string;
}

export interface Kpi {
	id: string;
	label: string;
	value: number;
	prev?: number;
	hint?: string;
	tone: "neutral" | "warn" | "danger";
	href?: string;
}

export interface PayloadInfo {
	rules: string[];
	matchedVars: string[];
	/** Base64 ciphertext; decryptable only in the browser, with the operator's private key. */
	encrypted: string | null;
}

export interface RawEvent {
	zoneId: string;
	zoneName: string;
	datetime: string;
	rayName: string | null;
	clientIP: string | null;
	country: string | null;
	asnDescription: string | null;
	ja4: string | null;
	host: string | null;
	path: string | null;
	method: string | null;
	status: number | null;
	securityAction: string | null;
	injectionScore: number | null;
	piiCategories: string[];
	unsafeTopicCategories: string[];
	customTopics: { topicLabel: string; score: number }[];
	customTopicScoreMin: number | null;
	tokenCount: number | null;
	sampleInterval: number;
	payload: PayloadInfo | null;
	operationId: string | null;
}

export interface EndpointBreakdownRow {
	key: string;
	host: string;
	path: string;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	total: number;
}

export interface CountryRow {
	code: string;
	name: string;
	flag: string;
	requests: number;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	distinctIps: number;
	maxSeverity: Severity;
}

export interface ZoneRollupRow {
	zoneId: string;
	zoneName: string;
	llmRequests: number;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	error: string | null;
}

export interface AttackerSessionRow {
	ip: string | null;
	country: string | null;
	asn: string | null;
	ja4: string | null;
	firstSeen: string;
	lastSeen: string;
	requests: number;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	blocked: number;
	distinctTargets: number;
	distinctIps: number;
}

export interface TimePoint {
	ts: string;
	count: number;
}

export interface DetectionPoint {
	ts: string;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
}

/**
 * Everything one window of AI Security telemetry produces.
 *
 * `mitigations` and `mitigationCoverage` are computed by the aggregation and carried here, but
 * nothing renders them yet — the original app kept that section behind a flag because the
 * recommendations come from a single window of traffic rather than a tuned policy.
 */
export interface AiSecDashboard {
	window: TimeWindow;
	kpis: Kpi[];
	trafficSeries: TimePoint[];
	trafficSeriesPrev: TimePoint[];
	detectionSeries: DetectionPoint[];
	topicBreakdown: CountItem[];
	piiBreakdown: CountItem[];
	customBreakdown: CountItem[];
	injectionHistogram: CountItem[];
	injectionScores: { score: number; count: number }[];
	topCountries: CountItem[];
	topAsns: CountItem[];
	topIps: CountItem[];
	topTargets: CountItem[];
	endpointBreakdown: EndpointBreakdownRow[];
	countryBreakdown: CountryRow[];
	sampling: { rows: number; sampledRows: number; maxInterval: number };
	zoneRollup: ZoneRollupRow[];
	attackerSessions: AttackerSessionRow[];
	sessionKey: SessionKey;
	events: RawEvent[];
	zonesWithErrors: { zoneName: string; error: string }[];
	bucketFallback: { requested: string; used: string; zones: string[] } | null;
	totalEvents: number;
	truncated: boolean;
}

export interface AiSecResult {
	window: TimeWindow;
	zones: { id: string; name: string }[];
	data: AiSecDashboard;
}

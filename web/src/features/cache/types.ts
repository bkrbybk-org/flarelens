// Response shape of POST /api/cache/analyze (mirrors src/lib/cache-analysis.ts)

export type StatusCounts = Record<string, number>;

export interface RuleAnalytics {
	statuses: StatusCounts;
	hits: number;
	misses: number;
	bypass: number;
	hitRatio: number;
}

export interface RuleSettings {
	cache?: boolean;
	edgeTtl?: string;
	browserTtl?: string;
	customCacheKey?: boolean;
	serveStale?: boolean;
	respectStrongEtags?: boolean;
}

export interface TopUrl {
	url: string;
	requests: number;
	hitRatio: number;
}

export interface CacheRule {
	id: string;
	description: string;
	expression: string;
	enabled: boolean;
	action: string;
	settings: RuleSettings;
	attribution: "measured" | "unattributable" | "mock";
	attributionNote?: string;
	analytics: RuleAnalytics;
	topUrls?: TopUrl[];
}

export interface UnattributedBlock {
	analytics: RuleAnalytics;
	topUrls: TopUrl[];
	mixed: boolean;
}

export interface TrendBucket {
	t: string;
	statuses: StatusCounts;
}

export interface ZoneTotals {
	requests: number;
	cached: number;
	sampledRequests: number;
	coveragePct: number;
}

export interface Insight {
	severity: "warn" | "info";
	message: string;
}

export interface VersioningInfo {
	enabled: boolean;
	environments: Array<{ name: string; version: number | null }>;
	versionZones: string[];
}

export interface CacheAnalysis {
	zoneName: string;
	zoneId: string;
	rangeHours: number;
	insights: Insight[];
	health: { ratio: number; grade: string } | null;
	versioning: VersioningInfo;
	analyticsSource: "path-graphql" | "zero-traffic" | "mock";
	analyticsReason?: string;
	rules: CacheRule[];
	unattributed: UnattributedBlock | null;
	timeseries: TrendBucket[] | null;
	zoneTotals: ZoneTotals | null;
	hosts: string[];
}

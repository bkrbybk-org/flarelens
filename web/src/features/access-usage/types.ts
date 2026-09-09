/**
 * No 30-day option: Cloudflare's login dataset refuses any window wider than one week, so the
 * longest preset is 7d. The last one is nudged inside the limit — a request built at exactly 7d
 * can round to a hair over by the time it reaches the API and be refused outright.
 */
export const ACCESS_PRESETS = {
	"6h": { label: "6h", ms: 6 * 3_600_000 },
	"24h": { label: "24h", ms: 24 * 3_600_000 },
	"7d": { label: "7d", ms: 7 * 86_400_000 - 60_000 },
} as const;

export type AccessPreset = keyof typeof ACCESS_PRESETS;
export type AccessGranularity = "hourly" | "daily";

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

export const SUCCESS_COLOR = "#10b981";
export const FAILURE_COLOR = "#ef4444";

/**
 * Counts from this dataset are adaptively sampled, so they arrive pre-scaled and rounded (10,
 * 190, 1260…). Rendered as-is rather than dressed up with false precision.
 */
export function formatLogins(value: number): string {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return value.toLocaleString();
}

export function successRate(totals: { success: number; total: number }): string {
	if (!totals.total) return "—";
	return `${((totals.success / totals.total) * 100).toFixed(1)}%`;
}

export function accessBucketLabel(ts: string, granularity: AccessGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
}

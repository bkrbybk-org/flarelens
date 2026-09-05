export type GatewayGranularity = "hourly" | "daily";

export interface GatewayPoint {
	ts: string;
	allowed: number;
	blocked: number;
}

export interface GatewayBreakdownRow {
	key: string;
	allowed: number;
	blocked: number;
	total: number;
}

export interface GatewayTotals {
	allowed: number;
	blocked: number;
	total: number;
}

export interface GatewayUsageResult {
	granularity: GatewayGranularity;
	timeDimension: string;
	dns: { series: GatewayPoint[]; totals: GatewayTotals; byCategory: GatewayBreakdownRow[]; byPolicy: GatewayBreakdownRow[] };
	http: { series: GatewayPoint[]; totals: GatewayTotals; byHost: GatewayBreakdownRow[]; byAction: GatewayBreakdownRow[] };
	truncated: boolean;
}

export const EMPTY_TOTALS: GatewayTotals = { allowed: 0, blocked: 0, total: 0 };

export function compactCount(value: number): string {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return value.toLocaleString();
}

export function blockRate(totals: GatewayTotals): string {
	return totals.total ? `${((totals.blocked / totals.total) * 100).toFixed(2)}%` : "0%";
}

export function gatewayBucketLabel(ts: string, granularity: GatewayGranularity): string {
	const date = new Date(ts.length === 10 ? `${ts}T00:00:00Z` : ts);
	if (Number.isNaN(date.getTime())) return ts;
	if (granularity === "daily") return date.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
}

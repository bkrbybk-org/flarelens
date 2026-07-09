// Ported from cf-waf-rules-analyzer src/lib/constants.js

export const DEFAULT_LOOKBACK_MINUTES = 15;
export const MAX_GRAPH_BUCKETS = 30;
export const HOURLY_GRAPH_THRESHOLD_MINUTES = 1440;
export const GRAPH_DIMENSIONS = { width: 920, height: 220, padding: 28, gap: 4 };
export const TOP_HOST_LIMIT = 3;
// Worker cursor-paginates 5 x 10k rows; at this total the window is likely truncated.
export const EVENT_LIMIT = 50000;

export const LOOKBACK_OPTIONS: [number, string][] = [
	[5, "5 mins"],
	[15, "15 mins"],
	[30, "30 mins"],
	[60, "1 hour"],
	[180, "3 hours"],
	[360, "6 hours"],
	[1440, "24 hours"],
	[4320, "3 days"],
	[10080, "7 days"],
	[20160, "14 days"],
	[43200, "30 days"],
];

export const AUTO_REFRESH_OPTIONS: [number, string][] = [
	[0, "Off"],
	[30000, "30s"],
	[60000, "1 min"],
	[300000, "5 min"],
];

export interface ChartAction {
	key: string;
	label: string;
	actions: string[];
	color: string;
	dotClass: string;
}

export const CHART_ACTIONS: ChartAction[] = [
	{ key: "block", label: "Block", actions: ["block"], color: "#dc2626", dotClass: "bg-red-600" },
	{ key: "managed_challenge", label: "Managed Challenge", actions: ["managed_challenge", "challenge"], color: "#f97316", dotClass: "bg-orange-500" },
	{ key: "js_challenge", label: "JS Challenge", actions: ["js_challenge"], color: "#facc15", dotClass: "bg-yellow-400" },
	{ key: "log", label: "Log", actions: ["log"], color: "#0284c7", dotClass: "bg-sky-600" },
];

// Full literal class strings so the Tailwind scanner picks them up.
export const actionColors: Record<string, string> = {
	block: "bg-red-600 text-white",
	challenge: "bg-amber-500 text-zinc-950",
	managed_challenge: "bg-orange-500 text-white",
	js_challenge: "bg-yellow-400 text-zinc-950",
	log: "bg-sky-600 text-white",
	simulate: "bg-violet-600 text-white",
	allow: "bg-emerald-600 text-white",
};

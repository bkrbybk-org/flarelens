import type { AiGatewayGranularity, AiGatewaySeriesPoint, AiGatewaySplitPoint } from "./types";

/**
 * The stacked chart's data: every bucket in the window, each split into the top few gateways,
 * models or sources plus "Other".
 *
 * Buckets come from the window, not from the rows: a day with no requests returns no row, and a
 * chart built from rows alone would silently close the gap — seven bars for a window with four
 * active days would read as four consecutive busy ones.
 */

export type Split = "none" | "gateway" | "model" | "provider" | "client" | "source";
export type StackMetric = "requests" | "tokens" | "cost" | "errors";

export const WORKERS_AI = "Workers AI";
export const THIRD_PARTY = "Third-party";
export const OTHER = "Other";
const TOP = 6;

/** Workers AI is Cloudflare's own inference; every other provider is a third-party LLM. */
export function sourceOf(provider: string): string {
	return provider === "workers-ai" ? WORKERS_AI : THIRD_PARTY;
}

const STEP_MS: Record<Exclude<AiGatewayGranularity, "daily">, number> = { "15m": 15 * 60_000, hourly: 3_600_000 };

/** Bucket keys spelled as the API spells them: `YYYY-MM-DD` for days, `…T…:00Z` otherwise. */
export function windowBuckets(from: string, to: string, granularity: AiGatewayGranularity): string[] {
	const start = Date.parse(from);
	const end = Date.parse(to);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
	const out: string[] = [];
	if (granularity === "daily") {
		const day = new Date(start);
		day.setUTCHours(0, 0, 0, 0);
		for (let t = day.getTime(); t <= end && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
		return out;
	}
	const step = STEP_MS[granularity];
	for (let t = Math.floor(start / step) * step; t <= end && out.length < 3000; t += step) {
		out.push(new Date(t).toISOString().replace(".000Z", "Z"));
	}
	return out;
}

export interface Stacks {
	/** Stack order, bottom first: biggest first, "Other" last. */
	keys: string[];
	buckets: { ts: string; values: Record<string, number>; total: number }[];
	/** Each key's total over the window, for the legend. */
	totals: Record<string, number>;
}

export function buildStacks(
	series: AiGatewaySeriesPoint[],
	splitPoints: AiGatewaySplitPoint[],
	split: Split,
	metric: StackMetric,
	bucketKeys: string[],
): Stacks {
	const keyed: { ts: string; key: string; value: number }[] =
		split === "none"
			? series.map((p) => ({ ts: p.ts, key: "All", value: p[metric] ?? 0 }))
			: splitPoints.map((p) => ({ ts: p.ts, key: split === "source" ? sourceOf(p.key) : p.key, value: p[metric] ?? 0 }));

	const totals: Record<string, number> = {};
	for (const { key, value } of keyed) totals[key] = (totals[key] ?? 0) + value;
	const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
	const kept = new Set(ranked.length > TOP + 1 ? ranked.slice(0, TOP) : ranked);
	const label = (key: string) => (kept.has(key) ? key : OTHER);

	const byTs = new Map<string, Record<string, number>>();
	for (const { ts, key, value } of keyed) {
		const values = byTs.get(ts) ?? {};
		values[label(key)] = (values[label(key)] ?? 0) + value;
		byTs.set(ts, values);
	}
	const foldedTotals: Record<string, number> = {};
	for (const key of ranked) foldedTotals[label(key)] = (foldedTotals[label(key)] ?? 0) + totals[key];
	const keys = [...ranked.filter((k) => kept.has(k)), ...(ranked.some((k) => !kept.has(k)) ? [OTHER] : [])];

	// The window's buckets, plus any the rows carry outside it (a bucket straddling the edge).
	const allTs = [...new Set([...bucketKeys, ...byTs.keys()])].sort();
	return {
		keys,
		totals: foldedTotals,
		buckets: allTs.map((ts) => {
			const values = byTs.get(ts) ?? {};
			return { ts, values, total: Object.values(values).reduce((a, b) => a + b, 0) };
		}),
	};
}

/** Categorical, colour-blind-distinguishable; red is kept for errors, grey for "Other". */
export const STACK_COLORS = ["#f6821f", "#2563eb", "#0d9488", "#7c3aed", "#ca8a04", "#db2777"];
export const OTHER_COLOR = "#a1a1aa";
export const SOURCE_COLORS: Record<string, string> = { [WORKERS_AI]: "#f6821f", [THIRD_PARTY]: "#2563eb" };

export function colorFor(key: string, index: number, split: Split): string {
	if (key === OTHER) return OTHER_COLOR;
	if (split === "source") return SOURCE_COLORS[key] ?? OTHER_COLOR;
	return STACK_COLORS[index % STACK_COLORS.length];
}

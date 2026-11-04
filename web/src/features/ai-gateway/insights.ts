import { compactCount, formatCost, formatDuration, type AiGatewayBreakdownRow, type AiGatewayUsageResult } from "./types";

/**
 * "At a glance": the few things in the numbers worth reading first — where traffic and spend
 * concentrate, what got slower or stopped caching since the previous window, where errors come
 * from — each with a way to drill into the slice it names.
 *
 * Only claims the data supports: a breakdown with a single row says nothing about concentration,
 * a change needs a previous value, and nothing is said about a measure the schema does not carry.
 */

export interface Insight {
	text: string;
	tone: "info" | "warn" | "bad";
	drill?: { key: "gateway" | "provider" | "model"; value: string };
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** The row with the most of a measure, when there is more than one row to compare. */
function topBy(rows: AiGatewayBreakdownRow[], measure: (r: AiGatewayBreakdownRow) => number | null): AiGatewayBreakdownRow | null {
	if (rows.length < 2) return null;
	let best: AiGatewayBreakdownRow | null = null;
	for (const row of rows) {
		const value = measure(row);
		if (value === null || value <= 0) continue;
		if (!best || value > (measure(best) ?? 0)) best = row;
	}
	return best;
}

export function buildInsights(result: AiGatewayUsageResult): Insight[] {
	const out: Insight[] = [];
	const { totals, previous, filter } = result;
	if (!totals.requests) return out;

	// Changes since the previous window that usually mean something broke or got more expensive.
	if (previous && previous.requests > 0) {
		if (totals.cacheHitRate !== null && previous.cacheHitRate !== null && previous.cacheHitRate - totals.cacheHitRate >= 0.2) {
			out.push({
				tone: "bad",
				text: `Cache hit rate fell from ${Math.round(previous.cacheHitRate * 100)}% to ${Math.round(totals.cacheHitRate * 100)}% since the previous window — requests that were served from cache now reach the provider and are paid for.`,
			});
		}
		if (totals.p50 !== null && previous.p50 !== null && previous.p50 > 0 && totals.p50 >= previous.p50 * 2) {
			out.push({ tone: "warn", text: `Median latency went from ${formatDuration(previous.p50)} to ${formatDuration(totals.p50)}.` });
		}
		if (totals.cost !== null && previous.cost !== null && previous.cost > 0 && totals.cost >= previous.cost * 2) {
			out.push({ tone: "warn", text: `Spend is ${(totals.cost / previous.cost).toFixed(1)}× the previous window (${formatCost(previous.cost)} → ${formatCost(totals.cost)}).` });
		}
	}

	// Where traffic and spend concentrate, for the dimensions not already pinned.
	if (!filter.gateway) {
		const top = topBy(result.byGateway, (r) => r.requests);
		if (top && top.requests / totals.requests >= 0.5) {
			out.push({ tone: "info", text: `Gateway "${top.key}" carries ${pct(top.requests, totals.requests)} of requests.`, drill: { key: "gateway", value: top.key } });
		}
	}
	if (!filter.model && totals.cost) {
		const top = topBy(result.byModel, (r) => r.cost);
		if (top?.cost) {
			out.push({
				tone: "info",
				text: `"${top.key}" is ${pct(top.cost, totals.cost)} of spend (${formatCost(top.cost)}) from ${pct(top.requests, totals.requests)} of requests.`,
				drill: { key: "model", value: top.key },
			});
		}
	}
	if (!filter.model) {
		// Slowest model with enough requests for a p95 to mean something.
		const slow = topBy(
			result.byModel.filter((r) => r.requests >= 3),
			(r) => r.p95,
		);
		if (slow?.p95 && slow.p95 >= 30_000) {
			out.push({ tone: "warn", text: `"${slow.key}" has the slowest tail: p95 ${formatDuration(slow.p95)} (median ${formatDuration(slow.p50)}).`, drill: { key: "model", value: slow.key } });
		}
	}

	// Where the errors come from.
	if (totals.errors) {
		const dimension = !filter.model ? "model" : !filter.provider ? "provider" : !filter.gateway ? "gateway" : null;
		const rows = dimension === "model" ? result.byModel : dimension === "provider" ? result.byProvider : dimension === "gateway" ? result.byGateway : [];
		const worst = rows.length ? [...rows].sort((a, b) => (b.errors ?? 0) - (a.errors ?? 0))[0] : null;
		const statuses = result.byStatus.filter((s) => Number(s.statusCode) >= 400).map((s) => `${s.statusCode} ×${compactCount(s.requests)}`);
		out.push({
			tone: "bad",
			text: `${compactCount(totals.errors)} failed ${totals.errors === 1 ? "request" : "requests"}${worst?.errors && dimension ? `, most from ${dimension} "${worst.key}" (${compactCount(worst.errors)})` : ""}${statuses.length ? ` — status ${statuses.join(", ")}` : ""}.`,
			drill: worst?.errors && dimension ? { key: dimension, value: worst.key } : undefined,
		});
	}
	if (totals.rateLimited) {
		out.push({ tone: "warn", text: `${compactCount(totals.rateLimited)} requests were rate limited by the gateway.` });
	}
	return out;
}

import { compactCount, formatCost, formatDuration, type AiGatewayBreakdownRow, type AiGatewayConfigResult, type AiGatewayFlow, type AiGatewayUsageResult } from "./types";

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
	const untagged = untaggedGateway(result);
	if (untagged) out.push(untagged);
	return out;
}

/**
 * Where user tagging is missing: the gateway whose traffic most often arrives without a `user`
 * tag. Spend first, as the gap chargeback feels; failing that, requests — untagged traffic that
 * happens to be cheap (cached, small models) is still traffic nobody can be asked about. Only on
 * an account that tags some traffic — one that tags none is not using the feature, not leaving
 * gaps in it — and only when the gap is worth acting on: at least a tenth of the window, and a
 * fifth of that gateway.
 */
function untaggedGateway(result: AiGatewayUsageResult): Insight | null {
	const { flows, filter } = result;
	if (!flows?.length || filter.user) return null;
	type Flow = (typeof flows)[number];
	const gap = (value: (f: Flow) => number) => {
		if (!flows.some((f) => f.user !== "(not tagged)" && value(f) > 0)) return null;
		const perGateway = new Map<string, { all: number; untagged: number }>();
		let whole = 0;
		for (const f of flows) {
			const entry = perGateway.get(f.gateway) ?? { all: 0, untagged: 0 };
			entry.all += value(f);
			if (f.user === "(not tagged)") entry.untagged += value(f);
			perGateway.set(f.gateway, entry);
			whole += value(f);
		}
		const [gateway, worst] = [...perGateway.entries()].sort((a, b) => b[1].untagged - a[1].untagged)[0] ?? [];
		return gateway && worst && whole && worst.untagged / whole >= 0.1 && worst.untagged / worst.all >= 0.2 ? { gateway, worst } : null;
	};
	const bySpend = gap((f) => f.cost ?? 0);
	const found = bySpend ?? gap((f) => f.requests);
	if (!found) return null;
	const { gateway, worst } = found;
	const amount = bySpend ? `spend (${formatCost(worst.untagged)}), so that spend` : `requests (${compactCount(worst.untagged)}), so those requests`;
	return {
		tone: "warn",
		text: `Gateway "${gateway}" carries no user tag on ${pct(worst.untagged, worst.all)} of its ${amount} cannot be put down to anyone. Have its clients send cf-aig-metadata with a "user" key.`,
		drill: filter.gateway ? undefined : { key: "gateway", value: gateway },
	};
}

export interface CoverageGap {
	gateway: string;
	requests: number;
	gaps: string[];
	/** Nothing stands between this gateway's traffic and the model: Guardrails are off or only flag. */
	unblocked: boolean;
}

/** Gateways that carry traffic with a protection missing, the busiest first. An idle gateway is no exposure. */
export function coverageGaps(config: AiGatewayConfigResult | null, byGateway: AiGatewayBreakdownRow[]): CoverageGap[] {
	if (!config || config.error) return [];
	const settings = new Map(config.gateways.map((g) => [g.id, g]));
	const out: CoverageGap[] = [];
	for (const row of byGateway) {
		const g = settings.get(row.key);
		if (!g || row.requests <= 0) continue;
		const blocks = g.guardrails ? g.guardrails.prompt.block.length + g.guardrails.response.block.length : 0;
		const gaps = [
			...(!g.guardrails ? ["Guardrails off"] : !blocks ? ["Guardrails only flag, block nothing"] : []),
			...(!g.dlp ? ["DLP off"] : !g.dlp.policies.length ? ["DLP on, no policies"] : []),
			...(!g.authentication ? ["no authentication"] : []),
			...(!g.collectLogs ? ["logs off"] : []),
		];
		if (gaps.length) out.push({ gateway: g.id, requests: row.requests, gaps, unblocked: !blocks });
	}
	return out.sort((a, b) => b.requests - a.requests);
}

/** The one coverage line worth reading first: the busiest gateway nothing blocks on. */
export function coverageInsight(gaps: CoverageGap[], result: AiGatewayUsageResult): Insight | null {
	const worst = gaps.find((g) => g.unblocked);
	if (!worst || !result.totals.requests) return null;
	const others = gaps.filter((g) => g.unblocked).length - 1;
	return {
		tone: "warn",
		text: `Gateway "${worst.gateway}" carries ${pct(worst.requests, result.totals.requests)} of requests (${compactCount(worst.requests)}) with ${worst.gaps[0]}.${others > 0 ? ` ${others} more ${others === 1 ? "gateway" : "gateways"} with traffic block nothing either; see Gateway settings.` : ""}`,
		drill: result.filter.gateway ? undefined : { key: "gateway", value: worst.gateway },
	};
}

export interface CacheSavings {
	/** What the cached requests would have cost, at each model's average for a request it answered. */
	saved: number;
	cachedRequests: number;
	/** Cached requests on models with no paid request in the window, which no figure can be put on. */
	unpriced: number;
}

/**
 * What the gateway cache saved, as an estimate: each model's average cost for a request that reached
 * it, times its requests answered from cache. A cached answer may well have been a cheaper or dearer
 * call than average, so this is a size, not a bill.
 */
export function cacheSavings(flows: AiGatewayFlow[] | null): CacheSavings | null {
	if (!flows?.length) return null;
	const perModel = new Map<string, { cost: number; paid: number; cached: number }>();
	for (const f of flows) {
		const entry = perModel.get(f.model) ?? { cost: 0, paid: 0, cached: 0 };
		if (f.action !== null) {
			if (f.action === "From cache") entry.cached += f.requests;
			else if (f.action === "Passed") {
				entry.cost += f.cost ?? 0;
				entry.paid += f.requests;
			}
		} else {
			const cached = f.cached ?? 0;
			entry.cached += cached;
			entry.cost += f.cost ?? 0;
			entry.paid += Math.max(0, f.requests - cached - (f.errors ?? 0));
		}
		perModel.set(f.model, entry);
	}
	let saved = 0;
	let cachedRequests = 0;
	let unpriced = 0;
	for (const { cost, paid, cached } of perModel.values()) {
		cachedRequests += cached;
		if (cost > 0 && paid > 0) saved += (cost / paid) * cached;
		else unpriced += cached;
	}
	return cachedRequests ? { saved, cachedRequests, unpriced } : null;
}

export function cacheInsight(savings: CacheSavings | null): Insight | null {
	if (!savings?.saved) return null;
	return {
		tone: "info",
		text: `The gateway cache answered ${compactCount(savings.cachedRequests)} requests, about ${formatCost(savings.saved)} the models would have charged at their average this window${savings.unpriced ? `; ${compactCount(savings.unpriced)} more were on models with no priced request` : ""}.`,
	};
}

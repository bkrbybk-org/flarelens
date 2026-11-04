import { describe, expect, it } from "vitest";
import { buildInsights } from "../web/src/features/ai-gateway/insights";
import { change, formatCost, formatDuration } from "../web/src/features/ai-gateway/types";
import type { AiGatewayBreakdownRow, AiGatewayUsageResult } from "../web/src/features/ai-gateway/types";

/** The AI Gateway page's "At a glance" lines: only what the numbers support, each pointing at a slice. */

const slice = (key: string, requests: number, extra: Partial<AiGatewayBreakdownRow> = {}): AiGatewayBreakdownRow => ({
	key,
	requests,
	tokensIn: 0,
	tokensOut: 0,
	cost: 0,
	errors: 0,
	cached: 0,
	p50: null,
	p95: null,
	...extra,
});

function result(overrides: Partial<AiGatewayUsageResult> = {}): AiGatewayUsageResult {
	return {
		granularity: "hourly",
		timeDimension: "datetimeHour",
		series: [],
		totals: { requests: 78, tokensIn: 3_000_000, tokensOut: 160_000, cost: 1.18, errors: 1, errorRate: 1 / 78, cacheHits: 0, cacheMisses: 78, cacheHitRate: 0, p50: 12_275, p95: 368_576, rateLimited: 0 },
		byGateway: [slice("default", 29), slice("internal-ai", 24), slice("demo", 25)],
		byProvider: [slice("workers-ai", 77), slice("ceramic", 1, { errors: 1 })],
		byModel: [
			slice("@cf/deepseek", 27, { cost: 0.9, p50: 21_000, p95: 202_000 }),
			slice("@cf/kimi", 22, { cost: 0.2, p50: 9_000, p95: 40_000 }),
			slice("search", 1, { errors: 1 }),
		],
		byStatus: [
			{ statusCode: "200", rateLimited: false, requests: 76 },
			{ statusCode: "402", rateLimited: false, requests: 1 },
			{ statusCode: "499", rateLimited: false, requests: 1 },
		],
		recent: [],
		previous: { requests: 296, tokens: 274_219, cost: 0.089, errorRate: 0, cacheHitRate: 0.73, p50: 61 },
		previousWindow: { since: "", until: "" },
		filter: {},
		truncated: false,
		datasets: { errors: { available: true }, cache: { available: true }, spend: { available: true } },
		...overrides,
	};
}

describe("buildInsights", () => {
	it("calls out a cache collapse, slower responses, higher spend, the costliest and slowest models, and the errors", () => {
		const lines = buildInsights(result());
		const texts = lines.map((l) => l.text);
		expect(texts[0]).toMatch(/^Cache hit rate fell from 73% to 0%/);
		expect(texts).toContain("Median latency went from 61 ms to 12.3 s.");
		expect(texts.some((t) => t.startsWith("Spend is 13.3× the previous window"))).toBe(true);
		const costly = lines.find((l) => l.text.startsWith('"@cf/deepseek" is 76% of spend'))!;
		expect(costly.drill).toEqual({ key: "model", value: "@cf/deepseek" });
		expect(lines.find((l) => l.text.includes("slowest tail"))!.drill).toEqual({ key: "model", value: "@cf/deepseek" });
		const errors = lines.find((l) => l.tone === "bad" && l.text.startsWith("1 failed request"))!;
		expect(errors.text).toBe('1 failed request, most from model "search" (1) — status 402 ×1, 499 ×1.');
		expect(errors.drill).toEqual({ key: "model", value: "search" });
		// No gateway carries half the traffic here, so nothing is said about concentration.
		expect(texts.some((t) => t.startsWith("Gateway"))).toBe(false);
	});

	it("says nothing about a dimension already drilled into, or without anything to compare", () => {
		const lines = buildInsights(result({ filter: { model: "@cf/deepseek" }, previous: null, byModel: [slice("@cf/deepseek", 27, { cost: 0.9 })] }));
		expect(lines.some((l) => l.drill?.key === "model")).toBe(false);
		expect(lines.some((l) => l.text.startsWith("Cache hit rate fell"))).toBe(false);
		// Errors are then traced to the next dimension out.
		expect(lines.find((l) => l.text.includes("failed"))!.text).toContain('provider "ceramic"');
	});

	it("is empty for an empty window", () => {
		expect(buildInsights(result({ totals: { ...result().totals, requests: 0 } }))).toEqual([]);
	});
});

describe("formatting", () => {
	it("keeps sub-cent costs distinguishable from zero", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.000067)).toBe("$0.000067");
		expect(formatCost(1.1755)).toBe("$1.18");
		expect(formatCost(null)).toBe("—");
	});

	it("formats durations at a readable scale", () => {
		expect(formatDuration(61)).toBe("61 ms");
		expect(formatDuration(12_275)).toBe("12.3 s");
		expect(formatDuration(368_576)).toBe("6.1 min");
	});

	it("has no percentage change from nothing", () => {
		expect(change(10, 0)).toBeNull();
		expect(change(10, null)).toBeNull();
		expect(change(15, 10)).toBe(0.5);
	});
});

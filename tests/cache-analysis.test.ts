import { describe, expect, it } from "vitest";
import {
	attributeAnalytics,
	computeInsights,
	summarize,
	type CacheRule,
	type PathGroup,
	type RuleShell,
} from "../src/lib/cache-analysis";

const shell = (id: string, expression: string, enabled = true, settings = {}): RuleShell => ({
	id, description: id, expression, enabled, action: "set_cache_settings", settings,
});

const group = (path: string, status: string, requests: number, host = "example.com"): PathGroup => ({
	host, path, status, requests,
});

const rule = (id: string, expression: string, analytics: Partial<CacheRule["analytics"]> = {}, extra: Partial<CacheRule> = {}): CacheRule => ({
	id, description: id, expression, enabled: true, action: "set_cache_settings", settings: {},
	attribution: "measured",
	analytics: { statuses: {}, hits: 0, misses: 0, bypass: 0, hitRatio: 0, ...analytics },
	...extra,
});

describe("summarize", () => {
	it("buckets statuses into served/origin/bypass with CF-consistent ratio", () => {
		const a = summarize({ hit: 70, stale: 5, revalidated: 5, miss: 10, expired: 5, dynamic: 4, bypass: 1 });
		expect(a.hits).toBe(80);
		expect(a.misses).toBe(15);
		expect(a.bypass).toBe(5);
		expect(a.hitRatio).toBe(80);
	});
	it("zero traffic → zero ratio", () => {
		expect(summarize({}).hitRatio).toBe(0);
	});
});

describe("attributeAnalytics", () => {
	it("credits each path to the LAST matching enabled rule", () => {
		const rules = [
			shell("first", 'starts_with(http.request.uri.path, "/img/")'),
			shell("second", 'starts_with(http.request.uri.path, "/img/")'),
		];
		const { byRule } = attributeAnalytics(rules, [group("/img/a.png", "hit", 100)], 0);
		expect(byRule.get("second")?.analytics.hits).toBe(100);
		expect(byRule.get("first")?.analytics.hits).toBe(0);
	});

	it("disabled rules never match", () => {
		const rules = [shell("off", "true", false), shell("on", "true")];
		const { byRule } = attributeAnalytics(rules, [group("/x", "hit", 10)], 0);
		expect(byRule.has("off")).toBe(false);
		expect(byRule.get("on")?.analytics.hits).toBe(10);
	});

	it("unmatched traffic lands in the unattributed block, never redistributed", () => {
		const rules = [shell("images", 'starts_with(http.request.uri.path, "/img/")')];
		const { byRule, unattributed } = attributeAnalytics(rules, [
			group("/img/a.png", "hit", 60),
			group("/api/data", "dynamic", 40),
		], 0);
		expect(byRule.get("images")?.analytics.hits).toBe(60);
		expect(unattributed).not.toBeNull();
		expect(unattributed!.analytics.bypass).toBe(40);
		expect(unattributed!.mixed).toBe(false);
	});

	it("mixed flag set when unattributable rules exist", () => {
		const { unattributed } = attributeAnalytics([shell("r", "true")], [group("/x", "dynamic", 5)], 1);
		// rule "true" matches everything, so nothing lands unattributed here…
		expect(unattributed).toBeNull();
		const res = attributeAnalytics([shell("r", 'http.request.uri.path eq "/never"')], [group("/x", "dynamic", 5)], 2);
		expect(res.unattributed!.mixed).toBe(true);
	});

	it("ranks topUrls by requests with per-URL served ratio", () => {
		const rules = [shell("all", "true")];
		const { byRule } = attributeAnalytics(rules, [
			group("/a", "hit", 100),
			group("/b", "miss", 300),
			group("/a", "miss", 100),
		], 0);
		const urls = byRule.get("all")!.topUrls;
		expect(urls[0].url).toBe("example.com/b");
		expect(urls[1]).toMatchObject({ url: "example.com/a", requests: 200, hitRatio: 50 });
	});

	it("collects top hosts by traffic", () => {
		const { hosts } = attributeAnalytics([shell("r", "true")], [
			group("/x", "hit", 10, "small.com"),
			group("/y", "hit", 90, "big.com"),
		], 0);
		expect(hosts[0]).toBe("big.com");
	});
});

describe("computeInsights", () => {
	it("warns on duplicate expressions (later rule wins)", () => {
		const rules = [rule("a", 'http.request.uri.path eq "/x"'), rule("b", 'http.request.uri.path  eq  "/x"')];
		const { insights } = computeInsights(rules, "path-graphql", null);
		expect(insights.some((i) => i.severity === "warn" && i.message.includes("same expression"))).toBe(true);
	});

	it("warns on trailing catch-all rule", () => {
		const rules = [rule("a", 'http.request.uri.path eq "/x"'), rule("catch", "true")];
		const { insights } = computeInsights(rules, "path-graphql", null);
		expect(insights.some((i) => i.message.includes("matches all traffic"))).toBe(true);
	});

	it("warns on low hit ratio for caching rules with volume", () => {
		const bad = rule("slow", 'http.request.uri.path eq "/x"', { hits: 300, misses: 700, hitRatio: 30 }, { settings: { cache: true } });
		const { insights } = computeInsights([bad], "path-graphql", null);
		expect(insights.some((i) => i.severity === "warn" && i.message.includes("30.0%"))).toBe(true);
	});

	it("reports paused rules", () => {
		const { insights } = computeInsights([rule("p", "true", {}, { enabled: false })], "path-graphql", null);
		expect(insights.some((i) => i.message.includes("paused"))).toBe(true);
	});

	it("grade thresholds: 90→A, 75→B, 60→C, 40→D, else F", () => {
		const graded = (hits: number, misses: number) =>
			computeInsights([rule("r", "true", { hits, misses, hitRatio: 0 })], "path-graphql", null).health?.grade;
		expect(graded(95, 5)).toBe("A");
		expect(graded(80, 20)).toBe("B");
		expect(graded(65, 35)).toBe("C");
		expect(graded(45, 55)).toBe("D");
		expect(graded(10, 90)).toBe("F");
	});

	it("no health grade on mock or zero-traffic sources", () => {
		const r = rule("r", "true", { hits: 100 });
		expect(computeInsights([r], "mock", null).health).toBeNull();
		expect(computeInsights([r], "zero-traffic", null).health).toBeNull();
	});

	it("unattributed share over 30% produces info insight", () => {
		const r = rule("r", "true", { hits: 50 });
		const unattributed = {
			analytics: { statuses: {}, hits: 0, misses: 0, bypass: 50, hitRatio: 0 },
			topUrls: [], mixed: false,
		};
		const { insights } = computeInsights([r], "path-graphql", unattributed);
		expect(insights.some((i) => i.message.includes("matched no"))).toBe(true);
	});
});

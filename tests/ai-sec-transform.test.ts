import { describe, expect, it } from "vitest";
import {
	bucketGrid,
	bucketTs,
	hasNarrow,
	isCustomTopic,
	isInjection,
	isPii,
	isTerminated,
	isUnsafe,
	matchesDetection,
	matchesNarrow,
	scoreLabel,
} from "../src/lib/ai-sec/domain/transform";
import { buildWindow, buildCustomWindow } from "../src/lib/ai-sec/domain/params";
import { INJECTION_ATTACK_THRESHOLD, INJECTION_UNSCORED } from "../src/lib/ai-sec/domain/catalog";
import { event } from "./helpers/ai-sec-fixtures";

/** Unit cover for the detection predicates and bucketing that every panel is derived from. */

describe("detection predicates", () => {
	it("treats a LOW injection score as the attack, not a high one", () => {
		// Inverted scale: Cloudflare scores 1 as "almost certainly injection".
		expect(isInjection(event({ injectionScore: 1 }))).toBe(true);
		expect(isInjection(event({ injectionScore: INJECTION_ATTACK_THRESHOLD - 1 }))).toBe(true);
		expect(isInjection(event({ injectionScore: INJECTION_ATTACK_THRESHOLD }))).toBe(false);
		expect(isInjection(event({ injectionScore: 99 }))).toBe(false);
	});

	it("does not count an unscored request as an injection", () => {
		expect(isInjection(event({ injectionScore: INJECTION_UNSCORED }))).toBe(false);
		expect(isInjection(event({ injectionScore: null }))).toBe(false);
	});

	it("flags pii and unsafe topics on any non-empty category list", () => {
		expect(isPii(event({ piiCategories: ["CREDIT_CARD"] }))).toBe(true);
		expect(isPii(event())).toBe(false);
		expect(isUnsafe(event({ unsafeTopicCategories: ["S4"] }))).toBe(true);
		expect(isUnsafe(event())).toBe(false);
	});

	it("accepts either source of evidence for a custom topic", () => {
		// The object array is the readable evidence; the scalar is what the aggregate filter
		// uses. A schema may expose only one, so a row check must accept either.
		expect(isCustomTopic(event({ customTopics: [{ topicLabel: "Refunds", score: 4 }] }))).toBe(true);
		expect(isCustomTopic(event({ customTopicScoreMin: 12 }))).toBe(true);
		expect(isCustomTopic(event({ customTopicScoreMin: 100 }))).toBe(false);
		expect(isCustomTopic(event())).toBe(false);
	});

	it("routes matchesDetection to the matching predicate, and 'all' matches everything", () => {
		const pii = event({ piiCategories: ["EMAIL"] });
		expect(matchesDetection(pii, "pii")).toBe(true);
		expect(matchesDetection(pii, "injection")).toBe(false);
		expect(matchesDetection(event(), "all")).toBe(true);
	});
});

describe("isTerminated", () => {
	it("recognises terminating actions case-insensitively", () => {
		expect(isTerminated(event({ securityAction: "block" }))).toBe(true);
		expect(isTerminated(event({ securityAction: "BLOCK" }))).toBe(true);
		expect(isTerminated(event({ securityAction: "challenge" }))).toBe(true);
	});

	it("does not treat logging or an absent action as termination", () => {
		expect(isTerminated(event({ securityAction: "log" }))).toBe(false);
		expect(isTerminated(event({ securityAction: null }))).toBe(false);
	});
});

describe("matchesNarrow", () => {
	const rich = event({
		clientIP: "203.0.113.7",
		country: "TH",
		host: "api.example.com",
		path: "/v1/chat",
		ja4: "t13d1516h2",
		piiCategories: ["CREDIT_CARD"],
		unsafeTopicCategories: ["S4"],
		customTopics: [{ topicLabel: "Refunds", score: 3 }],
		securityAction: "block",
	});

	it("matches an empty narrow", () => {
		expect(matchesNarrow(rich, {})).toBe(true);
		expect(hasNarrow({})).toBe(false);
	});

	it("ANDs across keys and ORs within one key", () => {
		expect(matchesNarrow(rich, { country: ["TH", "SG"] })).toBe(true);
		expect(matchesNarrow(rich, { country: ["SG"] })).toBe(false);
		expect(matchesNarrow(rich, { country: ["TH"], ip: ["203.0.113.7"] })).toBe(true);
		expect(matchesNarrow(rich, { country: ["TH"], ip: ["198.51.100.1"] })).toBe(false);
	});

	it("compares category columns against display labels, not API codes", () => {
		// A drill-down link carries one value that must satisfy both this and the browser filter.
		expect(matchesNarrow(rich, { piiVals: ["CREDIT_CARD"] })).toBe(false);
		expect(matchesNarrow(rich, { piiVals: ["Credit card number"] })).toBe(true);
	});

	it("builds the target column as host + path", () => {
		expect(matchesNarrow(rich, { target: ["api.example.com/v1/chat"] })).toBe(true);
		expect(matchesNarrow(rich, { target: ["api.example.com"] })).toBe(false);
	});

	it("maps mitigated onto the same true/false vocabulary the picker accepts", () => {
		expect(matchesNarrow(rich, { mitigated: ["true"] })).toBe(true);
		expect(matchesNarrow(rich, { mitigated: ["false"] })).toBe(false);
		expect(matchesNarrow(event({ securityAction: "log" }), { mitigated: ["false"] })).toBe(true);
	});

	it("never matches a null field against a wanted value", () => {
		expect(matchesNarrow(event(), { ip: ["203.0.113.7"] })).toBe(false);
		expect(matchesNarrow(event(), { country: ["TH"] })).toBe(false);
	});

	it("hasNarrow ignores keys present but empty", () => {
		expect(hasNarrow({ ip: [] })).toBe(false);
		expect(hasNarrow({ ip: ["203.0.113.7"] })).toBe(true);
	});
});

describe("bucketTs", () => {
	it("truncates to each supported dimension", () => {
		const iso = "2026-09-04T10:07:33.512Z";
		expect(bucketTs(iso, "date")).toBe("2026-09-04");
		expect(bucketTs(iso, "datetimeFiveMinutes")).toBe("2026-09-04T10:05:00.000Z");
		expect(bucketTs(iso, "datetimeFifteenMinutes")).toBe("2026-09-04T10:00:00.000Z");
		expect(bucketTs(iso, "datetimeHour")).toBe("2026-09-04T10:00:00.000Z");
	});

	it("falls back to hourly for an unknown dimension", () => {
		// This is why params.ts may only emit names from the known set.
		expect(bucketTs("2026-09-04T10:07:33.512Z", "datetimeMinute")).toBe("2026-09-04T10:00:00.000Z");
	});

	it("returns the input unchanged when it is not a date", () => {
		expect(bucketTs("not-a-date", "datetimeHour")).toBe("not-a-date");
	});
});

describe("bucketGrid", () => {
	it("covers the window inclusively at the window's own step", () => {
		const win = buildWindow("1h", new Date("2026-09-04T10:00:00Z"));
		const grid = bucketGrid(win);
		expect(grid[0]).toBe("2026-09-04T09:00:00.000Z");
		expect(grid[grid.length - 1]).toBe("2026-09-04T10:00:00.000Z");
		expect(grid).toHaveLength(13); // 60 minutes / 5-minute buckets, both ends included
	});

	it("emits date-shaped buckets for a 30-day window and steps a day at a time", () => {
		const win = buildWindow("30d", new Date("2026-09-04T10:00:00Z"));
		const grid = bucketGrid(win);
		expect(grid[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(grid.length).toBeGreaterThanOrEqual(30);
		expect(grid.length).toBeLessThanOrEqual(32);
	});

	it("stays inside the limit:1000 the series aliases impose", () => {
		const win = buildCustomWindow(Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-08-30T00:00:00Z"));
		expect(bucketGrid(win).length).toBeLessThanOrEqual(1000);
	});

	it("produces buckets in strictly increasing order with no duplicates", () => {
		const grid = bucketGrid(buildWindow("6h", new Date("2026-09-04T10:00:00Z")));
		expect(new Set(grid).size).toBe(grid.length);
		expect([...grid].sort()).toEqual(grid);
	});
});

describe("scoreLabel", () => {
	it("distinguishes absent from unscored from a real score", () => {
		expect(scoreLabel(null)).toBe("—");
		expect(scoreLabel(INJECTION_UNSCORED)).toBe("not scored");
		expect(scoreLabel(7)).toBe("7");
	});
});

import { describe, expect, it } from "vitest";
import {
	INJECTION_ATTACK_THRESHOLD,
	INJECTION_BUCKETS,
	INJECTION_UNSCORED,
	PII_CATEGORIES,
	UNSAFE_TOPICS,
	categorySeverity,
	injectionBucket,
	piiLabel,
	unsafeTopicLabel,
} from "../src/lib/ai-sec/domain/catalog";
import { countryFlag, countryName } from "../src/lib/ai-sec/domain/geo";
import { buildMitigations, type SignalStat } from "../src/lib/ai-sec/domain/mitigations";

/** Unit cover for the label catalogs, country rendering, and mitigation ranking. */

describe("injectionBucket", () => {
	it("covers every score from 1 to 100 with exactly one bucket", () => {
		for (let score = 1; score <= INJECTION_UNSCORED; score++) {
			const matches = INJECTION_BUCKETS.filter((b) => score >= b.min && score <= b.max);
			expect(matches, `score ${score}`).toHaveLength(1);
		}
	});

	it("puts scores below the attack threshold in the critical bucket", () => {
		expect(injectionBucket(1).tone).toBe("critical");
		expect(injectionBucket(INJECTION_ATTACK_THRESHOLD - 1).tone).toBe("critical");
		expect(injectionBucket(INJECTION_ATTACK_THRESHOLD).tone).not.toBe("critical");
	});

	it("separates 'not scored' from the benign end of the scale", () => {
		expect(injectionBucket(INJECTION_UNSCORED).label).toBe("Not scored");
		expect(injectionBucket(99).label).not.toBe("Not scored");
	});

	it("falls back rather than returning undefined for an out-of-range score", () => {
		expect(injectionBucket(-5)).toBeDefined();
		expect(injectionBucket(1000)).toBeDefined();
	});
});

describe("category labels", () => {
	it("resolves known codes to human labels", () => {
		expect(piiLabel("CREDIT_CARD")).toBe("Credit card number");
		expect(unsafeTopicLabel("S4")).toBe("Child sexual exploitation");
	});

	it("passes an unknown code through instead of rendering 'undefined'", () => {
		// New Cloudflare categories must degrade to the raw code, not a broken cell.
		expect(piiLabel("BRAND_NEW_CATEGORY")).toBe("BRAND_NEW_CATEGORY");
		expect(unsafeTopicLabel("S99")).toBe("S99");
	});

	it("gives every catalogued category a label and a severity", () => {
		for (const [code, info] of Object.entries(PII_CATEGORIES)) {
			expect(info.name, code).toBeTruthy();
			expect(categorySeverity("pii", code)).toBe(info.severity);
		}
		for (const [code, info] of Object.entries(UNSAFE_TOPICS)) {
			expect(info.name, code).toBeTruthy();
			expect(categorySeverity("topic", code)).toBe(info.severity);
		}
	});

	it("gives an uncatalogued code a defined severity rather than undefined", () => {
		expect(categorySeverity("pii", "NOT_A_CATEGORY")).toBeDefined();
	});
});

describe("country rendering", () => {
	it("names known countries and passes unknown codes through", () => {
		expect(countryName("TH")).toBe("Thailand");
		expect(countryName("ZZZZ")).toBe("ZZZZ");
	});

	it("computes a flag from the alpha-2 code", () => {
		expect(countryFlag("TH")).toBe("🇹🇭");
		expect(countryFlag("th")).toBe("🇹🇭");
	});

	it("emits no flag for pseudo-countries or malformed codes", () => {
		// A 🇽🇽 glyph beside "Unknown country" would read as a real place failing to render.
		expect(countryFlag("XX")).toBe("");
		expect(countryFlag("T")).toBe("");
		expect(countryFlag("THA")).toBe("");
		expect(countryFlag("1H")).toBe("");
		expect(countryFlag("")).toBe("");
	});
});

describe("buildMitigations", () => {
	const stat = (over: Partial<SignalStat>): SignalStat => ({
		kind: "pii",
		code: "CREDIT_CARD",
		count: 10,
		blocked: 0,
		...over,
	});

	it("drops signals with no occurrences", () => {
		expect(buildMitigations([stat({ count: 0 })])).toEqual([]);
	});

	it("ranks by severity tier first, even when the critical signal is fully blocked", () => {
		// Severity is the primary sort key and unmitigated volume only breaks ties inside a
		// tier. Intended: a block can be removed, the category's cost cannot. See the doc
		// comment on buildMitigations.
		const out = buildMitigations([
			stat({ kind: "unsafe", code: "S4", count: 50, blocked: 50 }),
			stat({ kind: "pii", code: "CRYPTO", count: 40, blocked: 0 }),
		]);
		expect(out[0].code).toBe("S4");
	});

	it("uses unmitigated volume to break ties within one severity tier", () => {
		const out = buildMitigations([
			stat({ kind: "pii", code: "CREDIT_CARD", count: 50, blocked: 50 }),
			stat({ kind: "pii", code: "US_SSN", count: 40, blocked: 0 }),
		]);
		// Both critical: the one nothing is stopping ranks first.
		expect(out[0].unmitigated).toBeGreaterThan(0);
		expect(out[0].code).toBe("US_SSN");
	});

	it("keeps kind and code unparsed so a drill-down link can be rebuilt", () => {
		const [m] = buildMitigations([stat({ kind: "custom", code: "Refunds: tier one", count: 3 })]);
		expect(m.kind).toBe("custom");
		expect(m.code).toBe("Refunds: tier one");
	});

	it("honours the result limit", () => {
		const many = Array.from({ length: 20 }, (_, i) => stat({ code: `C${i}`, count: 20 - i }));
		expect(buildMitigations(many, 3)).toHaveLength(3);
		expect(buildMitigations(many).length).toBeLessThanOrEqual(8);
	});

	it("orders by severity first, then by unmitigated volume", () => {
		const out = buildMitigations([
			stat({ kind: "unsafe", code: "S4", count: 5, blocked: 0 }),
			stat({ kind: "pii", code: "DATE_TIME", count: 500, blocked: 0 }),
		]);
		// S4 is critical, DATE_TIME low: severity wins despite the 100x volume gap.
		expect(out[0].code).toBe("S4");
	});
});

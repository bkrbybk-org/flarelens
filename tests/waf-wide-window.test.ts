import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wideWindowWarning } from "../web/src/features/waf/WafPage";

/**
 * The rendered component test (tests/components/*.test.tsx, jsdom) is the natural home for
 * checking the banner actually shows up in the page, but WafPage needs a lot of mocking to
 * mount at all. wideWindowWarning is extracted
 * as a pure function specifically so the threshold and copy are covered without that, and the
 * source assertion below pins that WafPage actually renders it with the shared ALERT_WARN token
 * and role="status", not just that the helper exists.
 */
describe("wideWindowWarning", () => {
	it("is null at and under the 7-day threshold", () => {
		expect(wideWindowWarning(10080)).toBeNull();
		expect(wideWindowWarning(1440)).toBeNull();
		expect(wideWindowWarning(0)).toBeNull();
	});

	it("warns past 7 days, naming the measured counts", () => {
		const warning = wideWindowWarning(10081);
		expect(warning).not.toBeNull();
		expect(warning).toMatch(/5,388/);
		expect(warning).toMatch(/18,440/);
		expect(warning).toMatch(/7 days/);
	});

	it("warns for a full 30-day window", () => {
		expect(wideWindowWarning(43200)).not.toBeNull();
	});
});

describe("WafPage source", () => {
	it("renders the wide-window warning with the shared ALERT_WARN token and role=status", () => {
		const source = readFileSync(new URL("../web/src/features/waf/WafPage.tsx", import.meta.url), "utf8");
		expect(source).toMatch(/import\s*\{[^}]*\bALERT_WARN\b[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/ui"/);
		expect(source).toMatch(/role="status"\s*className=\{ALERT_WARN\}/);
		expect(source).toMatch(/wideWindowWarning\(minutes\)/);
	});
});

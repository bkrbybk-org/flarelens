import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "../web/src/components/shell/nav";
import { ROUTES } from "../web/src/hooks/useRoute";

/**
 * The sidebar and the command palette both read `NAV_GROUPS` rather than keeping their own
 * lists, specifically so a new route added to `useRoute`'s `ROUTES` can't be forgotten in one of
 * the two. This is the guard that makes that true rather than aspirational.
 */

describe("NAV_GROUPS", () => {
	it("has exactly one entry per route", () => {
		const items = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.route));
		expect(items.sort()).toEqual([...ROUTES].sort());
	});

	it("has no route appearing in more than one group", () => {
		const items = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.route));
		expect(new Set(items).size).toBe(items.length);
	});

	it("gives every item a non-empty label and an icon", () => {
		for (const group of NAV_GROUPS) {
			for (const item of group.items) {
				expect(item.label.length).toBeGreaterThan(0);
				expect(item.icon).toBeTypeOf("function");
			}
		}
	});
});

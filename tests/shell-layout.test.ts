import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app shell is a fixed-height flex column: sidebar and top bar stay put, and each section
 * scrolls inside <main>. That only holds while every link in the chain can shrink.
 *
 * A flex item defaults to `min-height: auto`, so a column without `min-h-0` grows to fit its
 * content rather than being bounded by the h-dvh shell. The section's own `h-full overflow-auto`
 * then has nothing to resolve against, so it never becomes the scroll container — and the
 * shell's `overflow-hidden` box scrolls instead, dragging the sidebar and top bar out of view.
 * That is a layout bug with no runtime error and no failing test, which is why it is pinned here.
 */

const app = readFileSync(join(import.meta.dirname, "..", "web/src/App.tsx"), "utf8");

describe("app shell height chain", () => {
	it("bounds the shell to the viewport", () => {
		expect(app).toMatch(/className="flex h-dvh overflow-hidden"/);
	});

	it("lets the column between the shell and <main> shrink", () => {
		const column = app.match(/<div className="flex[^"]*flex-col">/)?.[0] ?? "";
		expect(column).toContain("min-h-0");
		expect(column).toContain("flex-1");
	});

	it("keeps <main> shrinkable and clipping, so sections own their scrolling", () => {
		const main = app.match(/<main className="[^"]*"/)?.[0] ?? "";
		expect(main).toContain("min-h-0");
		expect(main).toContain("flex-1");
		expect(main).toContain("overflow-hidden");
	});

	it("makes <main> a containing block for absolutely positioned descendants", () => {
		// Measured, not theorised: without `relative`, sr-only labels and in-input icons anchor
		// to the initial containing block rather than the scroller. On a long page that pushed
		// <html> to 1444px against a 900px viewport, so the document scrolled and took the
		// sidebar and top bar with it. `overflow` alone does not create a containing block.
		const main = app.match(/<main className="[^"]*"/)?.[0] ?? "";
		expect(main).toContain("relative");
	});

	it("gives every section a scroll container of its own", () => {
		// Each page is the thing that scrolls; if one stopped doing this, its content would be
		// clipped by <main> with no way to reach the rest.
		const pages = [
			"features/access-usage/AccessUsagePage.tsx",
			"features/ai-security/AiSecurityPage.tsx",
			"features/cache/CachePage.tsx",
			"features/cost/CostPage.tsx",
			"features/findings/FindingsPage.tsx",
			"features/gateway/GatewayPage.tsx",
			"features/pqc/PqcPage.tsx",
			"features/waf/WafPage.tsx",
			"features/workers/WorkersPage.tsx",
			"features/workers-ai/WorkersAiPage.tsx",
		];
		for (const page of pages) {
			const source = readFileSync(join(import.meta.dirname, "..", "web/src", page), "utf8");
			expect(source, page).toMatch(/className="h-full overflow-(y-)?auto/);
		}
	});
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reloading a section is one act, so it has one control in one place.
 *
 * It used to have two: three sections reloaded from "Sync" in the top bar, eleven drew their own
 * "Refresh" inside the page, in two different styles. The cost was not the duplication — it was
 * that arriving at an unfamiliar section meant looking for the control before using it.
 *
 * Pinned here because a new section would naturally grow its own button again, and nothing at
 * runtime would complain.
 */

const WEB = join(import.meta.dirname, "..", "web/src");

function sources(): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".tsx")) out.push({ path, text: readFileSync(path, "utf8") });
		}
	};
	walk(WEB);
	return out;
}

describe("refresh", () => {
	it("lives only in the top bar", () => {
		const offenders = sources()
			.filter(({ path }) => !path.endsWith(join("shell", "Topbar.tsx")))
			// A button whose label is Refresh, rather than any mention of the word.
			.filter(({ text }) => /\n\s*Refresh\n\s*<\/button>/.test(text))
			.map(({ path }) => path);
		expect(offenders).toEqual([]);
	});

	it("is offered by every section that can reload", () => {
		// Either the section registers its own loader, or it is one of the three backed by the
		// shared /api/data payload that App reloads directly. Request Trace is neither: it has
		// nothing to reload until a ray id is submitted, so it shows no Sync at all.
		const app = readFileSync(join(WEB, "App.tsx"), "utf8");
		expect(app).toContain('const DATA_ROUTES = new Set<Route>(["access", "groups", "findings"]);');

		const registering = sources()
			.filter(({ text }) => text.includes("useSectionRefresh("))
			.map(({ path }) => path.split("/").pop());
		expect(registering.sort()).toEqual([
			"AccessUsagePage.tsx",
			"AiGatewayPage.tsx",
			"AiSecurityPage.tsx",
			"BotsPage.tsx",
			"CachePage.tsx",
			"CostPage.tsx",
			"DnsPage.tsx",
			"GatewayPage.tsx",
			"PqcPage.tsx",
			"ShieldsPage.tsx",
			"TunnelMapPage.tsx",
			"WafPage.tsx",
			"WorkersAiPage.tsx",
			"WorkersPage.tsx",
			"ZoneHealthPage.tsx",
		]);
	});

	it("clears its registration on unmount, so Sync never drives the page just left", () => {
		const hook = readFileSync(join(WEB, "hooks/useSectionRefresh.ts"), "utf8");
		expect(hook).toMatch(/return \(\) => register\(null\);/);
	});
});

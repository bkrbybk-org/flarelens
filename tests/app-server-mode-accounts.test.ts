import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guardrail: server mode must not re-fetch the account list.
 *
 * fetchConfig() already returns the allowlisted accounts for a server-mode deployment
 * (config.accounts, held in serverAccounts). A second effect calling fetchAccounts() purely to
 * feed the sidebar switcher duplicates that upstream call — about a second of latency at
 * bootstrap for data App already has. BYOT still needs fetchAccounts, since fetchConfig returns
 * no account list for it. This is a source assertion, not a render test: mounting App.tsx pulls
 * in the whole app shell (routing, every feature page, hash-synced state), and rendering it in
 * jsdom to prove one effect didn't fire would cost far more setup than the guarantee is worth.
 */

const APP_SOURCE = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");

describe("App bootstrap: server mode reuses config.accounts", () => {
	it("guards the fetchAccounts effect on BYOT mode", () => {
		const effectStart = APP_SOURCE.indexOf("fetchAccounts(sessionToken");
		expect(effectStart).toBeGreaterThan(-1);
		// The guard clause immediately preceding the fetchAccounts call must bail out in server mode.
		const before = APP_SOURCE.slice(Math.max(0, effectStart - 300), effectStart);
		expect(before).toMatch(/session\?\.mode === "server"/);
	});

	it("feeds the sidebar switcher from serverAccounts in server mode", () => {
		expect(APP_SOURCE).toMatch(/const sidebarAccounts = session\?\.mode === "server" \? serverAccounts : accounts;/);
		expect(APP_SOURCE).toMatch(/accounts=\{sidebarAccounts\}/);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRulesetsForScope, type RuleMetaMap, type RulesetScope } from "../src/lib/waf-meta";

// Minimal fixture: one ruleset per scope, both containing rule id "rule-x"
// under different names, plus an empty entrypoint/detail response so
// collectRulesetsForScope's extra fetches resolve cleanly.
function fixtureFetch(rulesetName: string) {
	return vi.fn(async (url: string) => {
		if (url.endsWith("/rulesets")) {
			return jsonResponse({
				success: true,
				result: [
					{
						id: "rs-1",
						name: rulesetName,
						kind: "custom",
						phase: "http_request_firewall_custom",
						rules: [{ id: "rule-x", description: `${rulesetName} rule`, action: "block", enabled: true }],
					},
				],
			});
		}
		// detail fetch for rs-1, and the entrypoint fetch: nothing extra to add
		return jsonResponse({ success: true, result: null });
	});
}

function jsonResponse(body: unknown) {
	return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("collectRulesetsForScope + per-scope merge", () => {
	it("keeps last-write-wins merge order: zone overrides account for the same rule id", async () => {
		const accountScope: RulesetScope = { kind: "accounts", id: "acct1", source: "account" };
		const zoneScope: RulesetScope = { kind: "zones", id: "zone1", source: "zone:example.com" };

		// Simulates the worker's per-scope isolation: each scope writes into
		// its own empty map so concurrent completion order can't interleave.
		vi.stubGlobal("fetch", fixtureFetch("Account Ruleset"));
		const accountMeta: RuleMetaMap = {};
		await collectRulesetsForScope(accountScope, "token", accountMeta);

		vi.stubGlobal("fetch", fixtureFetch("Zone Ruleset"));
		const zoneMeta: RuleMetaMap = {};
		await collectRulesetsForScope(zoneScope, "token", zoneMeta);

		expect(accountMeta["rule-x"].name).toBe("Account Ruleset rule");
		expect(zoneMeta["rule-x"].name).toBe("Zone Ruleset rule");

		// Merge in original scope order (account-first-then-zones), same as
		// the worker's Object.assign loop over mapWithConcurrency results.
		const merged: RuleMetaMap = {};
		for (const scopeMeta of [accountMeta, zoneMeta]) {
			Object.assign(merged, scopeMeta);
		}

		expect(merged["rule-x"].name).toBe("Zone Ruleset rule");
		expect(merged["rule-x"].source).toBe("zone:example.com");
	});
});

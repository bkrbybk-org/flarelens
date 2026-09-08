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

// The managed-`execute` and entrypoint paths: a scope's ruleset list carries only the
// deployment rule, so the rule NAMES an operator sees for managed hits come from the follow-up
// detail fetch, and custom rules come from the phase entrypoint. Neither is in the list response.
function deploymentFetch() {
	return vi.fn(async (url: string) => {
		if (url.endsWith("/rulesets")) {
			return jsonResponse({
				success: true,
				result: [
					{
						id: "rs-deploy",
						name: "zone deployment",
						kind: "root",
						phase: "http_request_firewall_managed",
						rules: [
							{
								id: "deploy-rule",
								action: "execute",
								enabled: true,
								action_parameters: {
									id: "managed-rs",
									overrides: { ruleset: { description: "Cloudflare Managed Ruleset" } },
								},
							},
						],
					},
				],
			});
		}
		if (url.endsWith("/rulesets/managed-rs")) {
			return jsonResponse({
				success: true,
				result: {
					id: "managed-rs",
					name: "Cloudflare Managed Ruleset",
					kind: "managed",
					phase: "http_request_firewall_managed",
					rules: [{ id: "child-1", ref: "child-ref-1", description: "SQLi - Body", action: "block", enabled: true }],
				},
			});
		}
		if (url.endsWith(`/rulesets/phases/http_request_firewall_custom/entrypoint`)) {
			return jsonResponse({
				success: true,
				result: {
					id: "rs-entry",
					name: "default",
					kind: "zone",
					phase: "http_request_firewall_custom",
					rules: [{ id: "custom-1", description: "Block scanners", action: "block", enabled: false }],
				},
			});
		}
		return jsonResponse({ success: true, result: null });
	});
}

describe("managed execute targets and the custom firewall entrypoint", () => {
	const scope: RulesetScope = { kind: "zones", id: "zone1", source: "zone:example.com" };

	it("indexes the executed managed ruleset by its own id, named from the override", async () => {
		vi.stubGlobal("fetch", deploymentFetch());
		const meta: RuleMetaMap = {};
		await collectRulesetsForScope(scope, "token", meta);

		// An event that reports only the managed ruleset id still resolves to a name.
		const entry = meta["managed-rs"];
		expect(entry.name).toBe("Cloudflare Managed Ruleset");
		expect(entry.isRuleset).toBe(true);
		expect(entry.type).toBe("managed");
		expect(entry.kind).toBe("managed");
		expect(entry.level).toBe("zone");
	});

	it("pulls child rules in from the detail fetch, keyed by both id and ref", async () => {
		vi.stubGlobal("fetch", deploymentFetch());
		const meta: RuleMetaMap = {};
		await collectRulesetsForScope(scope, "token", meta);

		expect(meta["child-1"].name).toBe("SQLi - Body");
		// firewallEventsAdaptive reports ruleId as either form depending on the ruleset.
		expect(meta["child-ref-1"]).toBe(meta["child-1"]);
		expect(meta["child-1"].ruleset).toBe("Cloudflare Managed Ruleset");
		expect(meta["child-1"].rulesetId).toBe("managed-rs");
	});

	it("collects the custom firewall entrypoint, keeping a disabled rule", async () => {
		vi.stubGlobal("fetch", deploymentFetch());
		const meta: RuleMetaMap = {};
		await collectRulesetsForScope(scope, "token", meta);

		expect(meta["custom-1"].name).toBe("Block scanners");
		expect(meta["custom-1"].type).toBe("custom");
		// enabled:false must survive — Rules Review reports rules that are configured but off.
		expect(meta["custom-1"].enabled).toBe(false);
		expect(meta["rs-entry"].isRuleset).toBe(true);
	});

	it("survives a detail or entrypoint fetch the token cannot read", async () => {
		// tryCfFetch swallows these: a 403 on the managed detail must cost the child names,
		// not the whole scope.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/rulesets")) return (deploymentFetch() as unknown as (u: string) => Promise<Response>)(url);
				return { ok: false, json: async () => ({ success: false, errors: [{ message: "Authentication error" }] }) } as Response;
			}),
		);
		const meta: RuleMetaMap = {};
		await collectRulesetsForScope(scope, "token", meta);

		expect(meta["deploy-rule"].name).toBe("zone deployment");
		expect(meta["managed-rs"].name).toBe("Cloudflare Managed Ruleset");
		expect(meta["child-1"]).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { buildRayVerdict } from "../web/src/lib/waf/ray-verdict";
import type { RuleMetaEntry, RuleMetaMap } from "../web/src/lib/waf/types";

const CUSTOM = "http_request_firewall_custom";
const MANAGED = "http_request_firewall_managed";

const rs = (id: string, name: string, kind: string, phase: string, source: string): RuleMetaEntry => ({
	name, source, type: kind === "managed" ? "managed" : "custom", level: source === "account" ? "account" : "zone", phase, ruleset: name, rulesetId: id, kind, isRuleset: true,
});
const rule = (id: string, rulesetId: string, position: number, action: string, extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name: id, ruleId: id, source: "zone", type: "custom", level: "zone", phase: CUSTOM, ruleset: rulesetId, rulesetId, kind: "", action, enabled: true, expression: "x", position, ...extra,
});

// Account custom entrypoint runs a custom ruleset; the zone has its own custom rules and a managed deployment.
const meta: RuleMetaMap = {
	"acct-root": rs("acct-root", "root", "root", CUSTOM, "account"),
	exec: rule("exec", "acct-root", 0, "execute", { executes: "geo", source: "account", level: "account" }),
	geo: rs("geo", "Geography-based Ruleset", "custom", CUSTOM, "account"),
	"geo-block": rule("geo-block", "geo", 0, "block"),
	"geo-log": rule("geo-log", "geo", 1, "log"),
	"z-custom": rs("z-custom", "default", "zone", CUSTOM, "zone"),
	"z-1": rule("z-1", "z-custom", 0, "block"),
	"z-man": rs("z-man", "zone", "zone", MANAGED, "zone"),
	"z-exec": rule("z-exec", "z-man", 0, "execute", { executes: "cf-ai", phase: MANAGED }),
	"cf-ai": rs("cf-ai", "Firewall for AI", "managed", MANAGED, "zone"),
	"ai-1": rule("ai-1", "cf-ai", 0, "log", { type: "managed", phase: MANAGED }),
};

const ev = (ruleId: string, rulesetId: string, action: string, source: string, matchIndex = 0) => ({ ruleId, rulesetId, action, source, matchIndex, description: ruleId });

describe("buildRayVerdict", () => {
	it("names the rule that blocked, inside the ruleset that ran it, and marks everything after as not reached", () => {
		const v = buildRayVerdict([ev("geo-block", "geo", "block", "firewallCustom")], { securityAction: "block", securitySource: "firewallCustom" }, meta);
		expect(v.outcome).toEqual({ action: "block", source: "firewallCustom" });
		expect(v.decidedBy?.item.row.id).toBe("geo-block");
		const [acct, zoneCustom, zoneManaged] = v.stages;
		expect(acct.items[0].state).toBe("decided");
		expect(acct.items[0].innerHits.map((h) => [h.item.row.id, h.state])).toEqual([["geo-block", "decided"]]);
		expect(zoneCustom.items[0].state).toBe("not-reached");
		expect(zoneManaged.items[0].state).toBe("not-reached");
		expect(v.outside).toEqual([]);
	});

	it("places hits by evaluation order, not matchIndex — and logs never stop evaluation", () => {
		// Live shape: the managed-phase match carried matchIndex 0, the custom-phase one 3.
		const v = buildRayVerdict(
			[ev("ai-1", "cf-ai", "log", "firewallManaged", 0), ev("geo-log", "geo", "log", "firewallCustom", 3)],
			{ securityAction: "unknown" },
			meta,
		);
		expect(v.outcome).toBeNull();
		expect(v.decidedBy).toBeNull();
		expect(v.stages[0].items[0].innerHits.map((h) => [h.item.row.id, h.state])).toEqual([["geo-log", "matched"]]);
		expect(v.stages[1].items[0].state).toBe("no-match");
		expect(v.stages[2].items[0].innerHits.map((h) => h.state)).toEqual(["matched"]);
	});

	it("lists matches from outside the rulesets on their own", () => {
		const v = buildRayVerdict([ev("maze", "", "link_maze_injected", "linkMaze")], {}, meta);
		expect(v.outside.map((h) => h.source)).toEqual(["linkMaze"]);
		expect(v.stages.every((s) => s.items.every((i) => i.state === "no-match"))).toBe(true);
	});

	it("still shows a recorded match that the order says came after the stop", () => {
		const v = buildRayVerdict([ev("geo-block", "geo", "block", "firewallCustom"), ev("ai-1", "cf-ai", "log", "firewallManaged")], {}, meta);
		expect(v.stages[2].items[0].innerHits.map((h) => h.state)).toEqual(["matched"]);
		expect(v.outside).toEqual([]);
	});

	it("credits a match to the one deployment that ran it, when a ruleset is deployed several times", () => {
		// The same managed ruleset three times: one for another host, one blocking, one log-only.
		const many: RuleMetaMap = {
			"z-man": rs("z-man", "zone", "zone", MANAGED, "zone"),
			"d-other": rule("d-other", "z-man", 0, "execute", { executes: "cf-ai", phase: MANAGED, expression: 'http.host eq "other.example"' }),
			"d-block": rule("d-block", "z-man", 1, "execute", { executes: "cf-ai", phase: MANAGED, expression: "true", overrides: { action: "block" } }),
			"d-log": rule("d-log", "z-man", 2, "execute", { executes: "cf-ai", phase: MANAGED, expression: "true", overrides: { action: "log" } }),
			"cf-ai": rs("cf-ai", "Firewall for AI", "managed", MANAGED, "zone"),
			"ai-1": rule("ai-1", "cf-ai", 0, "block", { type: "managed", phase: MANAGED }),
		};
		const v = buildRayVerdict([ev("ai-1", "cf-ai", "log", "firewallManaged")], { clientRequestHTTPHost: "app.example" }, many);
		const owners = v.stages[0].items.map((i) => [i.item.row.id, i.innerHits.length]);
		// Not the one for another host, not the blocking one: the log-only deployment, matching the recorded action.
		expect(owners).toEqual([
			["d-other", 0],
			["d-block", 0],
			["d-log", 1],
		]);
	});
});

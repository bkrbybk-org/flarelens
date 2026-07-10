import { describe, expect, it } from "vitest";
import {
	actionDrift,
	actionSummary,
	aggregateRules,
	aggregateRulesets,
	countEventsByActions,
	topHosts,
} from "../web/src/lib/waf/aggregate";
import type { FirewallEvent, RuleMetaMap } from "../web/src/lib/waf/types";

const meta: RuleMetaMap = {
	"rule-a": {
		name: "Block bad logins", ruleId: "rule-a", source: "account", type: "custom", level: "account",
		ruleset: "Custom Rules", rulesetName: "Custom Rules", rulesetId: "rs-1", kind: "custom",
		action: "block", enabled: true, expression: 'http.request.uri.path eq "/login"',
	},
	// ref alias points at the same entry object
	"ref-a": {} as never,
	"rule-idle": {
		name: "Idle rule", ruleId: "rule-idle", source: "zone:example.com", type: "custom", level: "zone",
		ruleset: "Zone Rules", rulesetName: "Zone Rules", rulesetId: "rs-2", kind: "custom",
		action: "block", enabled: false, expression: "",
	},
	"rs-1": {
		name: "Custom Rules", source: "account", type: "custom", level: "account",
		isRuleset: true, rulesetId: "rs-1", ruleset: "Custom Rules", phase: "http_request_firewall_custom", kind: "custom",
	},
};
meta["ref-a"] = meta["rule-a"];

const ev = (ruleId: string, action: string, host: string, minsAgo: number, path = "/"): FirewallEvent => ({
	ruleId, action, clientRequestHTTPHost: host, clientRequestPath: path,
	datetime: new Date(Date.now() - minsAgo * 60000).toISOString(), source: "firewallCustom",
});

describe("aggregateRulesets", () => {
	it("groups events under parent ruleset with child rules", () => {
		const events = [ev("rule-a", "block", "a.com", 5), ev("rule-a", "block", "a.com", 3), ev("rule-a", "log", "b.com", 1)];
		const rows = aggregateRulesets(events, meta);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.ruleName).toBe("Custom Rules");
		expect(row.total).toBe(3);
		expect(row.actions).toEqual({ block: 2, log: 1 });
		expect(row.childRules.get("rule-a")?.total).toBe(3);
		expect(topHosts(row)[0]).toEqual(["a.com", 2]);
		expect(row.times).toHaveLength(3);
	});

	it("unknown rule ids fall back to source/id naming", () => {
		const rows = aggregateRulesets([ev("mystery", "block", "x.com", 1)], meta);
		expect(rows[0].ruleName).toContain("mystery");
		expect(rows[0].level).toBe("account");
	});

	it("sorts by total descending", () => {
		const events = [ev("mystery", "block", "x.com", 1), ev("rule-a", "block", "a.com", 1), ev("rule-a", "log", "a.com", 2)];
		const rows = aggregateRulesets(events, meta);
		expect(rows[0].ruleName).toBe("Custom Rules");
	});
});

describe("actionDrift", () => {
	it("flags configured vs observed mismatch", () => {
		const drift = actionDrift({ configuredAction: "block", actions: { log: 10, block: 2 } });
		expect(drift).toEqual({ configured: "block", observed: "log" });
	});
	it("no drift when top observed matches configured", () => {
		expect(actionDrift({ configuredAction: "block", actions: { block: 10, log: 2 } })).toBeNull();
	});
	it("no drift without configured action", () => {
		expect(actionDrift({ configuredAction: "", actions: { log: 5 } })).toBeNull();
	});
});

describe("aggregateRules (rules review)", () => {
	it("includes zero-traffic and disabled rules from metadata", () => {
		const rows = aggregateRules([], meta);
		const ids = rows.map((r) => r.id);
		expect(ids).toContain("rule-a");
		expect(ids).toContain("rule-idle");
		// ruleset-level entries excluded
		expect(ids).not.toContain("rs-1");
		const idle = rows.find((r) => r.id === "rule-idle")!;
		expect(idle.enabled).toBe(false);
		expect(idle.total).toBe(0);
	});

	it("dedupes id/ref aliases into one row", () => {
		const rows = aggregateRules([], meta);
		expect(rows.filter((r) => r.name === "Block bad logins")).toHaveLength(1);
	});

	it("accumulates events with hosts and paths", () => {
		const rows = aggregateRules([ev("rule-a", "block", "a.com", 2, "/login"), ev("rule-a", "log", "a.com", 1, "/login")], meta);
		const row = rows.find((r) => r.id === "rule-a")!;
		expect(row.total).toBe(2);
		expect(row.hosts.get("a.com")).toBe(2);
		expect(row.paths.get("/login")).toBe(2);
		expect(row.actions).toEqual({ block: 1, log: 1 });
	});
});

describe("summaries", () => {
	it("actionSummary shows top two plus overflow", () => {
		expect(actionSummary({ block: 10, log: 5, challenge: 1 })).toBe("Block 10, Log 5 +1");
		expect(actionSummary({})).toBe("-");
	});
	it("countEventsByActions filters by normalized action", () => {
		const events = [ev("r", "BLOCK", "h", 1), ev("r", "log", "h", 1)];
		expect(countEventsByActions(events, ["block"])).toBe(1);
	});
});

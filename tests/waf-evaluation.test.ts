import { describe, expect, it } from "vitest";
import { aggregateRules } from "../web/src/lib/waf/aggregate";
import { buildEvaluationOrder } from "../web/src/lib/waf/evaluation";
import type { RuleMetaEntry, RuleMetaMap } from "../web/src/lib/waf/types";

const rs = (id: string, name: string, kind: string, phase: string, source: string, extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name, source, type: kind === "managed" ? "managed" : "custom", level: source === "account" ? "account" : "zone",
	phase, ruleset: name, rulesetId: id, kind, isRuleset: true, ...extra,
});
const rule = (id: string, rulesetId: string, position: number, action: string, expression = "x", extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name: id, ruleId: id, source: "zone:a.example", type: "custom", level: "zone", phase: "", ruleset: rulesetId, rulesetId,
	kind: "", action, enabled: true, expression, position, ...extra,
});

const CUSTOM = "http_request_firewall_custom";
const RL = "http_ratelimit";
const MANAGED = "http_request_firewall_managed";

function build(meta: RuleMetaMap) {
	return buildEvaluationOrder(meta, aggregateRules([], meta));
}

describe("buildEvaluationOrder", () => {
	const base: RuleMetaMap = {
		"acct-root": rs("acct-root", "root", "root", CUSTOM, "account"),
		"acct-custom": rs("acct-custom", "Sensitive Paths", "custom", CUSTOM, "account"),
		exec: rule("exec", "acct-root", 0, "execute", "true", { executes: "acct-custom", phase: CUSTOM, source: "account", level: "account" }),
		"ac-1": rule("ac-1", "acct-custom", 1, "log", "x", { phase: CUSTOM }),
		"ac-0": rule("ac-0", "acct-custom", 0, "block", "x", { phase: CUSTOM }),
		"z-custom": rs("z-custom", "default", "zone", CUSTOM, "zone:a.example"),
		"zc-0": rule("zc-0", "z-custom", 0, "block", "y", { phase: CUSTOM }),
		"z-rl": rs("z-rl", "default", "zone", RL, "zone:a.example"),
		"zr-0": rule("zr-0", "z-rl", 0, "block", "true", { phase: RL }),
		"z-man": rs("z-man", "zone", "zone", MANAGED, "zone:a.example"),
		"zm-exec": rule("zm-exec", "z-man", 0, "execute", "true", { executes: "cf-managed", phase: MANAGED }),
		"cf-managed": rs("cf-managed", "Cloudflare Managed Ruleset", "managed", MANAGED, "zone:a.example"),
		"m-0": rule("m-0", "cf-managed", 0, "block", "sqli", { type: "managed", phase: MANAGED }),
		unused: rs("unused", "Never deployed", "custom", CUSTOM, "account"),
		"u-0": rule("u-0", "unused", 0, "block", "x", { phase: CUSTOM }),
	};

	it("orders phases, then account before zone, then rules by position — expanding execute rules", () => {
		const { stages } = build(base);
		expect(stages.map((s) => [s.phaseLabel, s.scope])).toEqual([
			["Custom rules", "Account"],
			["Custom rules", "a.example"],
			["Rate limiting rules", "a.example"],
			["Managed rules", "a.example"],
		]);
		const exec = stages[0].items[0];
		expect(exec.target?.name).toBe("Sensitive Paths");
		expect(exec.target?.items.map((i) => [i.row.id, i.position])).toEqual([["ac-0", 1], ["ac-1", 2]]);
		expect(stages[3].items[0].target?.items.map((i) => i.row.id)).toEqual(["m-0"]);
	});

	it("lists rulesets nothing deploys as never evaluated", () => {
		expect(build(base).undeployed).toEqual([
			{ id: "unused", name: "Never deployed", type: "custom", phase: CUSTOM, scope: "Account", ruleCount: 1 },
		]);
	});

	it("does not treat a match-all rate-limiting rule as stopping everything", () => {
		const { stages } = build(base);
		expect(stages[3].items[0].target?.items[0].unreachable).toBeUndefined();
	});

	it("marks everything after a zone's match-all block unreachable in that zone, later phases included", () => {
		const meta = { ...base, "zc-0": rule("zc-0", "z-custom", 0, "block", "true", { phase: CUSTOM }), "zc-1": rule("zc-1", "z-custom", 1, "log", "x", { phase: CUSTOM }) };
		const { stages } = build(meta);
		expect(stages[1].items.map((i) => i.unreachable)).toEqual([undefined, '"zc-0" stops every request before this rule.']);
		expect(stages[2].items[0].unreachable).toMatch(/zc-0/);
		expect(stages[3].items[0].target?.items[0].unreachable).toMatch(/zc-0/);
		// The account stage ran first and is untouched.
		expect(stages[0].items[0].target?.items.every((i) => !i.unreachable)).toBe(true);
	});

	it("carries a match-all block inside an every-request deployment through to every zone", () => {
		const meta = { ...base, "ac-0": rule("ac-0", "acct-custom", 0, "block", "true", { phase: CUSTOM }) };
		const { stages } = build(meta);
		expect(stages[0].items[0].target?.items[1].unreachable).toMatch(/Sensitive Paths/);
		expect(stages[1].items[0].unreachable).toMatch(/ac-0/);
	});

	it("ignores a match-all block that is disabled, logs, or sits in a narrower deployment", () => {
		for (const patch of <RuleMetaMap[]>[
			{ "zc-0": rule("zc-0", "z-custom", 0, "block", "true", { phase: CUSTOM, enabled: false }) },
			{ "zc-0": rule("zc-0", "z-custom", 0, "log", "true", { phase: CUSTOM }) },
			{ exec: rule("exec", "acct-root", 0, "execute", 'http.host eq "a"', { executes: "acct-custom", phase: CUSTOM }), "ac-0": rule("ac-0", "acct-custom", 0, "block", "true", { phase: CUSTOM }) },
		]) {
			const { stages } = build({ ...base, ...patch });
			expect(stages[2].items[0].unreachable).toBeUndefined();
		}
	});

	it("marks every rule of a ruleset whose execute rule is disabled", () => {
		const meta = { ...base, exec: rule("exec", "acct-root", 0, "execute", "true", { executes: "acct-custom", phase: CUSTOM, enabled: false }) };
		expect(build(meta).stages[0].items[0].target?.items.every((i) => /disabled/.test(i.unreachable ?? ""))).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { buildRayVerdict } from "../web/src/lib/waf/ray-verdict";
import { botSummary, owaspBreakdown, quote, requestExpression, reviewRay } from "../web/src/lib/waf/ray-review";
import type { RuleMetaEntry, RuleMetaMap } from "../web/src/lib/waf/types";

/** The false-positive / false-negative review laid over one request's verdict. */

const CUSTOM = "http_request_firewall_custom";
const MANAGED = "http_request_firewall_managed";

const rs = (id: string, name: string, kind: string, phase: string): RuleMetaEntry => ({
	name, source: "zone", type: kind === "managed" ? "managed" : "custom", level: "zone", phase, ruleset: name, rulesetId: id, kind, isRuleset: true,
});
const rule = (id: string, rulesetId: string, position: number, action: string, extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name: id, ruleId: id, source: "zone", type: "custom", level: "zone", phase: CUSTOM, ruleset: rulesetId, rulesetId, kind: "", action, enabled: true, expression: "x", position, ...extra,
});

const meta: RuleMetaMap = {
	root: rs("root", "default", "zone", CUSTOM),
	office: rule("office", "root", 0, "skip", { expression: "ip.src in {192.0.2.0/24}" }),
	geo: rule("geo", "root", 1, "block", { expression: 'ip.src.country in {"CN"}' }),
	off: rule("off", "root", 2, "block", { enabled: false }),
	man: rs("man", "zone", "zone", MANAGED),
	exec: rule("exec", "man", 0, "execute", { executes: "owasp", phase: MANAGED }),
	owasp: rs("owasp", "Cloudflare Managed Ruleset", "managed", MANAGED),
	sqli: rule("sqli", "owasp", 0, "block", { type: "managed", phase: MANAGED }),
};

const ev = (ruleId: string, action: string, source = "firewallCustom", extra: Record<string, unknown> = {}) => ({ ruleId, rulesetId: "root", action, source, description: ruleId, ...extra });
const req = { clientRequestHTTPHost: "example.com", clientRequestPath: "/login", clientIP: "198.51.100.7" };

describe("reviewRay — blocked requests (false positive?)", () => {
	it("drafts a narrowed custom rule and counts a human bot score in favour of a false positive", () => {
		const events = [ev("geo", "block", "firewallCustom", { metadata: [{ key: "matched_vars", value: "ip.src.country" }] })];
		const v = buildRayVerdict(events, { securityAction: "block" }, meta);
		const r = reviewRay(v, { ...req, botScore: 95 }, events);
		expect(r.question).toBe("false-positive");
		expect(r.title).toMatch(/likely a false positive/);
		expect(r.points.map((p) => p.text).join("\n")).toContain("It matched on: ip.src.country.");
		expect(r.suggestions[0].expression).toBe('(ip.src.country in {"CN"}) and not (http.host eq "example.com" and http.request.uri.path eq "/login")');
	});

	it("drafts a skip exception for a managed rule, and an attack score argues the block is right", () => {
		const events = [ev("sqli", "block", "firewallManaged")];
		const r = reviewRay(buildRayVerdict(events, { securityAction: "block" }, meta), { ...req, wafAttackScore: 8 }, events);
		expect(r.title).toBe("Blocked — is this a false positive?");
		expect(r.suggestions[0].action).toContain("Skip → specific rules: sqli");
		expect(r.points.some((p) => p.kind === "signal" && p.text.includes("may well be right"))).toBe(true);
	});

	it("points outside the WAF when another feature blocked it", () => {
		const r = reviewRay(buildRayVerdict([], { securityAction: "managed_challenge", securitySource: "securityLevel" }, meta), req, []);
		expect(r.question).toBe("false-positive");
		expect(r.points[0].text).toContain("outside the WAF rules, by securityLevel");
		expect(r.suggestions).toEqual([]);
	});
});

describe("reviewRay — requests let through (false negative?)", () => {
	it("names the skip that let it pass and the disabled rule that never ran", () => {
		const events = [ev("office", "skip")];
		const r = reviewRay(buildRayVerdict(events, { securityAction: "skip" }, meta), { ...req, edgeResponseStatus: 200 }, events);
		expect(r.question).toBe("false-negative");
		const text = r.points.map((p) => p.text).join("\n");
		expect(text).toContain('"office" (Zone custom rules, #1) skipped later rules');
		expect(text).toContain("ip.src in {192.0.2.0/24}");
		expect(text).toContain("1 disabled rule never ran: off");
		expect(text).toContain("Served with HTTP 200.");
	});

	it("does not tell you to change the action of something outside the WAF rules", () => {
		const events = [{ ruleId: "link_maze", rulesetId: "", action: "link_maze_injected", source: "linkMaze", description: "link_maze" }];
		const r = reviewRay(buildRayVerdict(events, {}, meta), req, events);
		expect(r.points[0]).toEqual({ kind: "note", text: '"link_maze" acted outside the WAF rules with "link_maze_injected" (linkMaze).' });
	});

	it("turns a flagging score into a suggested rule, plus a rule for requests like this one", () => {
		const r = reviewRay(buildRayVerdict([], {}, meta), { ...req, wafAttackScore: 12 }, []);
		expect(r.title).toMatch(/likely a false negative/);
		expect(r.suggestions.map((s) => s.expression)).toEqual([
			"cf.waf.score le 20",
			'http.host eq "example.com" and http.request.uri.path eq "/login" and ip.src eq 198.51.100.7',
		]);
	});
});

describe("managed rules, OWASP and bots", () => {
	const owaspMeta: RuleMetaMap = {
		...meta,
		owasp: rs("owasp", "Cloudflare OWASP Core Ruleset", "managed", MANAGED),
		score: rule("score", "owasp", 0, "block", { type: "managed", phase: MANAGED, name: "949110: Inbound Anomaly Score Exceeded" }),
		r1: rule("r1", "owasp", 1, "log", { type: "managed", phase: MANAGED, name: "920230: Multiple URL Encoding Detected", categories: ["protocol"] }),
		sqli: rule("sqli", "owasp", 2, "block", { type: "managed", phase: MANAGED, categories: ["sqli", "wordpress"] }),
	};

	it("offers a rule skip, a ruleset skip, a log override and category overrides for a managed rule", () => {
		const events = [ev("sqli", "block", "firewallManaged")];
		const r = reviewRay(buildRayVerdict(events, { securityAction: "block" }, owaspMeta), req, events, owaspMeta);
		const titles = r.suggestions.map((s) => s.title);
		expect(titles[0]).toBe("Exempt requests like this one from this managed rule");
		expect(titles).toContain('Exempt requests like this one from the whole "owasp" ruleset');
		expect(titles).toContain("Set this rule to Log in the deployment");
		expect(titles).toContain('Turn off the "wordpress" category');
		// The overrides have no expression and warn that they reach all traffic.
		const override = r.suggestions.find((s) => s.title === "Set this rule to Log in the deployment")!;
		expect(override.expression).toBe("");
		expect(override.caution).toMatch(/all traffic/);
	});

	it("explains an OWASP block by its score and the rules that added to it", () => {
		const events = [
			ev("score", "block", "firewallManaged", {
				metadata: [
					{ key: "score_total", value: "48" },
					{ key: "score_rules", value: '["r1","unknown-rule"]' },
				],
			}),
		];
		const v = buildRayVerdict(events, { securityAction: "block" }, owaspMeta);
		const breakdown = owaspBreakdown(v, events, owaspMeta)!;
		expect(breakdown.total).toBe(48);
		expect(breakdown.contributors).toEqual([
			{ id: "r1", name: "920230: Multiple URL Encoding Detected", categories: ["protocol"] },
			{ id: "unknown-rule", name: "unknown-rule", categories: [] },
		]);
		const r = reviewRay(v, req, events, owaspMeta);
		expect(r.points.some((p) => p.text.startsWith("OWASP anomaly score 48"))).toBe(true);
		expect(r.suggestions.map((s) => s.title)).toEqual(["Exempt requests like this one from the rules that scored it", "Raise the anomaly score threshold"]);
		expect(r.suggestions[0].action).toBe("Skip → specific rules: r1, unknown-rule");
	});

	it("reads bot management's view, and suggests exempting verified bots", () => {
		const botReq = { ...req, botScore: 1, botScoreSrcName: "Heuristics", verifiedBotCategory: "Search Engine Crawler", botDetectionIds: [33554461], jsDetectionPassed: "failed" };
		const lines = botSummary(botReq);
		expect(lines[0]).toBe("Bot score 1 — automated, from Heuristics.");
		expect(lines.join(" ")).toContain("Search Engine Crawler");
		expect(lines.join(" ")).toContain("33554461");
		expect(botSummary({})).toEqual([]);
		const events = [ev("geo", "block")];
		const r = reviewRay(buildRayVerdict(events, { securityAction: "block" }, meta), botReq, events);
		expect(r.suggestions.map((s) => s.expression)).toContain("cf.bot_management.verified_bot");
	});
});

describe("expression drafting", () => {
	it("escapes quotes and backslashes in string literals", () => {
		expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(requestExpression({ clientRequestPath: '/x"y' })).toBe('http.request.uri.path eq "/x\\"y"');
		expect(requestExpression({})).toBe("true");
	});
});

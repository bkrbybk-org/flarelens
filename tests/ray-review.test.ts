import { describe, expect, it } from "vitest";
import { buildRayVerdict } from "../web/src/lib/waf/ray-verdict";
import { quote, requestExpression, reviewRay } from "../web/src/lib/waf/ray-review";
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

	it("turns a flagging score into a suggested rule, plus a rule for requests like this one", () => {
		const r = reviewRay(buildRayVerdict([], {}, meta), { ...req, wafAttackScore: 12 }, []);
		expect(r.title).toMatch(/likely a false negative/);
		expect(r.suggestions.map((s) => s.expression)).toEqual([
			"cf.waf.score le 20",
			'http.host eq "example.com" and http.request.uri.path eq "/login" and ip.src eq 198.51.100.7',
		]);
	});
});

describe("expression drafting", () => {
	it("escapes quotes and backslashes in string literals", () => {
		expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(requestExpression({ clientRequestPath: '/x"y' })).toBe('http.request.uri.path eq "/x\\"y"');
		expect(requestExpression({})).toBe("true");
	});
});

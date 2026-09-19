import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
	buildGatewayPoliciesReport,
	buildStageViews,
	computeFindings,
	normaliseGatewayRule,
	type CfGatewayRule,
	type GwRule,
} from "../src/lib/gateway-policies";
import { ctx } from "./helpers/execution-context";

/**
 * Cover for Gateway Policies: enforcement-stage grouping, the narrow "shadowed" claim, and each
 * finding. The rule under test throughout matches the WAF evaluation-order view's own rule: a
 * claim about ordering or unreachability is only made in the one case the docs support outright.
 */

const ACCOUNT = "11111111111111111111111111111111";
const auth = { Authorization: "Bearer caller-token" };

function rawRule(over: Partial<CfGatewayRule> & { id: string; precedence: number; action: string; filters: CfGatewayRule["filters"] }): CfGatewayRule {
	return {
		name: over.id,
		description: "",
		enabled: true,
		traffic: "",
		identity: "",
		device_posture: "",
		...over,
	};
}

function rule(over: Partial<GwRule> & { id: string }): GwRule {
	return normaliseGatewayRule(
		rawRule({
			id: over.id,
			precedence: over.precedence ?? 0,
			action: over.action ?? "block",
			filters: over.filterType ? [over.filterType] : ["http"],
			enabled: over.enabled ?? true,
			traffic: over.traffic ?? "",
			identity: over.identity ?? "",
			device_posture: over.devicePosture ?? "",
			rule_settings: over.untrustedCertAction ? { untrusted_cert: { action: over.untrustedCertAction } } : undefined,
		}),
	);
}

describe("normaliseGatewayRule", () => {
	it("falls back sensibly on missing optional fields", () => {
		const r = normaliseGatewayRule({ id: "r1", precedence: 5, enabled: true, action: "block", filters: ["l4"] } as CfGatewayRule);
		expect(r.name).toBe("r1");
		expect(r.description).toBe("");
		expect(r.traffic).toBe("");
		expect(r.untrustedCertAction).toBeNull();
	});

	it("takes the first filter as the primary type", () => {
		const r = normaliseGatewayRule({ id: "r1", precedence: 0, enabled: true, action: "block", filters: ["dns", "http"] } as CfGatewayRule);
		expect(r.filterType).toBe("dns");
	});
});

describe("buildStageViews: ordering", () => {
	it("groups rules by filter type and orders each group by ascending precedence", () => {
		const rules = [
			rule({ id: "b", filterType: "http", precedence: 2, action: "block" }),
			rule({ id: "a", filterType: "http", precedence: 1, action: "block" }),
			rule({ id: "c", filterType: "dns", precedence: 0, action: "block" }),
		];
		const stages = buildStageViews(rules);
		const http = stages.find((s) => s.stage.id === "http")!;
		expect(http.rules.map((r) => r.rule.id)).toEqual(["a", "b"]);
		expect(http.rules[0].position).toBe(1);
		expect(http.rules[1].position).toBe(2);
	});

	it("keeps every documented stage present even with zero rules", () => {
		const stages = buildStageViews([]);
		expect(stages.map((s) => s.stage.id)).toEqual(["dns_resolver", "dns", "l4", "http"]);
		expect(stages.every((s) => s.rules.length === 0)).toBe(true);
	});
});

describe("buildStageViews: terminating actions", () => {
	it.each([
		["dns_resolver", "block", true],
		["dns_resolver", "resolve", true],
		["dns_resolver", "audit_ssh", false],
		["dns", "allow", true],
		["dns", "block", true],
		["dns", "override", true],
		["dns", "safesearch", true],
		["dns", "ytrestricted", true],
		["l4", "allow", true],
		["l4", "block", true],
		["l4", "log", false],
		["http", "off", true],
		["http", "isolate", true],
		["http", "allow", true],
		["http", "block", true],
		["http", "scan", false],
	] as const)("marks %s/%s terminating=%s", (filterType, action, expected) => {
		const stages = buildStageViews([rule({ id: "r1", filterType, action, precedence: 0 })]);
		const view = stages.find((s) => s.stage.id === filterType)!;
		expect(view.rules[0].terminating).toBe(expected);
	});

	it("a disabled rule is never terminating, even with a terminating action", () => {
		const stages = buildStageViews([rule({ id: "r1", filterType: "http", action: "block", enabled: false, precedence: 0 })]);
		const view = stages.find((s) => s.stage.id === "http")!;
		expect(view.rules[0].terminating).toBe(false);
	});
});

describe("buildStageViews: shadowing — the narrow claim only", () => {
	it("marks a rule shadowed by an earlier enabled, terminating, unconditional rule of the same type", () => {
		const stages = buildStageViews([
			rule({ id: "stopper", filterType: "http", action: "block", precedence: 1, traffic: "true" }),
			rule({ id: "victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const view = stages.find((s) => s.stage.id === "http")!;
		const victim = view.rules.find((r) => r.rule.id === "victim")!;
		expect(victim.shadowedBy).toEqual({ id: "stopper", name: "stopper" });
	});

	it("does not claim shadowing across different filter types", () => {
		const stages = buildStageViews([
			rule({ id: "stopper", filterType: "l4", action: "block", precedence: 1, traffic: "true" }),
			rule({ id: "not-victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const http = stages.find((s) => s.stage.id === "http")!;
		expect(http.rules[0].shadowedBy).toBeUndefined();
	});

	it("does not claim shadowing when the earlier rule's traffic condition is not a literal match-all", () => {
		const stages = buildStageViews([
			rule({ id: "narrow", filterType: "http", action: "block", precedence: 1, traffic: 'http.host == "example.com"' }),
			rule({ id: "not-victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const view = stages.find((s) => s.stage.id === "http")!;
		expect(view.rules[1].shadowedBy).toBeUndefined();
	});

	it("does not claim shadowing when the earlier rule carries an identity or device posture condition", () => {
		const stages = buildStageViews([
			rule({ id: "conditioned", filterType: "http", action: "block", precedence: 1, identity: 'identity.email == "a@example.com"' }),
			rule({ id: "not-victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const view = stages.find((s) => s.stage.id === "http")!;
		expect(view.rules[1].shadowedBy).toBeUndefined();
	});

	it("does not claim shadowing when the earlier match-all rule is disabled", () => {
		const stages = buildStageViews([
			rule({ id: "off", filterType: "http", action: "block", precedence: 1, enabled: false }),
			rule({ id: "not-victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const view = stages.find((s) => s.stage.id === "http")!;
		expect(view.rules[1].shadowedBy).toBeUndefined();
	});

	it("does not claim shadowing when the earlier match-all rule's action is non-terminating", () => {
		const stages = buildStageViews([
			rule({ id: "logger", filterType: "http", action: "scan", precedence: 1 }),
			rule({ id: "not-victim", filterType: "http", action: "allow", precedence: 2 }),
		]);
		const view = stages.find((s) => s.stage.id === "http")!;
		expect(view.rules[1].shadowedBy).toBeUndefined();
	});
});

describe("computeFindings", () => {
	it("flags a disabled rule as low severity", () => {
		const rules = [rule({ id: "r1", enabled: false })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "low", ruleId: "r1", title: "Rule disabled" }));
	});

	it("flags a shadowed rule as medium severity, only for the enabled victim", () => {
		const rules = [
			rule({ id: "stopper", filterType: "http", action: "block", precedence: 1, traffic: "true" }),
			rule({ id: "victim", filterType: "http", action: "allow", precedence: 2 }),
		];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "medium", ruleId: "victim", title: "Rule never runs" }));
	});

	it("flags an HTTP allow rule with no identity condition as medium", () => {
		const rules = [rule({ id: "r1", filterType: "http", action: "allow", identity: "" })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "medium", ruleId: "r1", title: "Allow rule with no identity condition" }));
	});

	it("does not flag an HTTP allow rule that does carry an identity condition", () => {
		const rules = [rule({ id: "r1", filterType: "http", action: "allow", identity: 'identity.email == "a@example.com"' })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings.find((f) => f.title === "Allow rule with no identity condition")).toBeUndefined();
	});

	it("flags an off (Do Not Inspect) rule as low/info", () => {
		const rules = [rule({ id: "r1", filterType: "http", action: "off" })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "low", ruleId: "r1", title: "Do Not Inspect rule" }));
	});

	it("flags rule_settings.untrusted_cert pass_through as medium", () => {
		const rules = [rule({ id: "r1", filterType: "http", action: "allow", identity: "x", untrustedCertAction: "pass_through" })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "medium", ruleId: "r1", title: "Untrusted certificates passed through" }));
	});

	it("does not flag untrusted_cert when the action is something other than pass_through", () => {
		const rules = [rule({ id: "r1", filterType: "http", action: "allow", identity: "x", untrustedCertAction: "block" })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings.find((f) => f.title === "Untrusted certificates passed through")).toBeUndefined();
	});

	it("flags a stage with zero rules as info", () => {
		const rules = [rule({ id: "r1", filterType: "http" })];
		const findings = computeFindings(rules, buildStageViews(rules));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "info", filterType: "dns", title: "No rules of this type" }));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "info", filterType: "l4", title: "No rules of this type" }));
		expect(findings).toContainEqual(expect.objectContaining({ severity: "info", filterType: "dns_resolver", title: "No rules of this type" }));
	});

	it("never raises a finding for data it never read — an empty rule set only ever produces the four zero-rule infos", () => {
		const findings = computeFindings([], buildStageViews([]));
		expect(findings).toHaveLength(4);
		expect(findings.every((f) => f.severity === "info")).toBe(true);
	});
});

describe("buildGatewayPoliciesReport", () => {
	it("totals rules by enabled state and type", () => {
		const raw: CfGatewayRule[] = [
			rawRule({ id: "a", precedence: 0, action: "block", filters: ["dns"], enabled: true }),
			rawRule({ id: "b", precedence: 1, action: "block", filters: ["http"], enabled: false }),
		];
		const report = buildGatewayPoliciesReport(raw);
		expect(report.totals).toEqual({ rules: 2, enabled: 1, disabled: 1, byType: { dns: 1, http: 1, l4: 0, dns_resolver: 0 } });
	});
});

// ---------------------------------------------------------------------------
// Route

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function list<T>(result: T[]): { success: true; result: T[]; result_info: { total_pages: number } } {
	return { success: true, result, result_info: { total_pages: 1 } };
}

function mockGatewayRules(rules: CfGatewayRule[] | { status: number; message: string }) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/gateway/rules")) {
			if (Array.isArray(rules)) return json(list(rules));
			return json({ success: false, errors: [{ message: rules.message }] }, rules.status);
		}
		return json(list([]));
	}) as typeof fetch;
}

beforeEach(() => mockGatewayRules([]));
afterEach(() => vi.restoreAllMocks());

describe("GET /api/gateway/policies", () => {
	it("returns rules, stages, findings and totals for an account", async () => {
		mockGatewayRules([rawRule({ id: "r1", precedence: 0, action: "block", filters: ["dns"] })]);
		const res = await app.request(`/api/gateway/policies?account_id=${ACCOUNT}`, { headers: auth }, ENV(), ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { totals: { rules: number } } };
		expect(body.result.totals.rules).toBe(1);
	});

	it("rejects a malformed account id before any upstream call", async () => {
		const res = await app.request("/api/gateway/policies?account_id=not-hex", { headers: auth }, ENV(), ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/gateway/policies?account_id=${ACCOUNT}`, {}, ENV(), ctx());
		expect(res.status).toBe(401);
	});

	it("maps an upstream failure to its own status, stating the error", async () => {
		mockGatewayRules({ status: 403, message: "Missing Zero Trust: Read" });
		const res = await app.request(`/api/gateway/policies?account_id=${ACCOUNT}`, { headers: auth }, ENV(), ctx());
		expect(res.status).toBe(403);
		const body = (await res.json()) as { success: boolean; errors: { message: string }[] };
		expect(body.success).toBe(false);
		expect(body.errors[0].message).toBe("Missing Zero Trust: Read");
	});

	// Scope refusal (server mode, account not allowlisted, no upstream call) is covered generically
	// for every scoped route, including this one, in tests/routes-auth.test.ts.
});

function ENV() {
	return { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
}

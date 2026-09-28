import { describe, expect, it } from "vitest";
import { buildEvalContext, evaluateAccess, ipMatches, type TestIdentity } from "../web/src/lib/access-eval";
import type { CfApp, CfGroup, CfList, CfPolicy } from "../web/src/types";

const LIST_ID = "55e12a45-e7a9-4455-bd01-423370fb32c3";
const lists: CfList[] = [{ id: LIST_ID, name: "Staff", type: "EMAIL", count: 2, items: ["a@example.com", "B@example.com"], items_truncated: false }];
const groups: CfGroup[] = [{ id: "g1", name: "Admins", include: [{ email: { email: "root@example.com" } }] }];
const ctx = buildEvalContext(groups, lists, [{ id: "idp-entra", name: "Entra ID" }, { id: "idp-otp", name: "OTP" }], {});

const policy = (over: Partial<CfPolicy>): CfPolicy => ({ id: over.id ?? "p", decision: "allow", precedence: 1, include: [], require: [], exclude: [], ...over });
const app = (policies: CfPolicy[], over: Partial<CfApp> = {}): CfApp => ({ id: "app", name: "App", policies, policies_error: false, ...over });
const user = (over: Partial<TestIdentity> = {}): TestIdentity => ({ mode: "user", idpId: "idp-entra", ...over });

describe("evaluateAccess — policy order and default deny", () => {
	it("allows a member of the email list", () => {
		const r = evaluateAccess(app([policy({ include: [{ email_list: { id: LIST_ID } }] })]), user({ email: "b@example.com" }), ctx);
		expect(r.verdict).toBe("allowed");
	});

	it("denies by default when nothing matches", () => {
		const r = evaluateAccess(app([policy({ include: [{ email_list: { id: LIST_ID } }] })]), user({ email: "x@example.com" }), ctx);
		expect(r.verdict).toBe("denied-default");
	});

	it("evaluates Bypass before Allow and Block regardless of precedence", () => {
		const r = evaluateAccess(
			app([
				policy({ id: "block", decision: "deny", precedence: 1, include: [{ everyone: {} }] }),
				policy({ id: "bypass", decision: "bypass", precedence: 2, include: [{ ip: { ip: "10.0.0.0/8" } }] }),
			]),
			user({ ip: "10.1.2.3" }),
			ctx,
		);
		expect(r.verdict).toBe("bypass");
		expect(r.decidedBy?.policy.id).toBe("bypass");
	});

	it("stops at the first Allow or Block in precedence order", () => {
		const r = evaluateAccess(
			app([
				policy({ id: "allow-all", decision: "allow", precedence: 2, include: [{ everyone: {} }] }),
				policy({ id: "block-domain", decision: "deny", precedence: 1, include: [{ email_domain: { domain: "evil.example" } }] }),
			]),
			user({ email: "m@evil.example" }),
			ctx,
		);
		expect(r.verdict).toBe("blocked");
		expect(r.decidedBy?.policy.id).toBe("block-domain");
	});

	it("applies Require as AND and Exclude as NOT", () => {
		const p = policy({ include: [{ email_domain: { domain: "example.com" } }], require: [{ geo: { country_code: "TH" } }], exclude: [{ email: { email: "a@example.com" } }] });
		expect(evaluateAccess(app([p]), user({ email: "c@example.com", country: "TH" }), ctx).verdict).toBe("allowed");
		expect(evaluateAccess(app([p]), user({ email: "c@example.com", country: "US" }), ctx).verdict).toBe("denied-default");
		expect(evaluateAccess(app([p]), user({ email: "a@example.com", country: "TH" }), ctx).verdict).toBe("denied-default");
	});

	it("evaluates an Access group by its own rules", () => {
		const p = policy({ include: [{ group: { id: "g1" } }] });
		expect(evaluateAccess(app([p]), user({ email: "root@example.com" }), ctx).verdict).toBe("allowed");
	});
});

describe("evaluateAccess — what the tester cannot know", () => {
	it("says 'depends' when an undecidable policy sits before the deciding one", () => {
		const r = evaluateAccess(
			app([
				policy({ id: "entra", decision: "deny", precedence: 1, include: [{ azureAD: { id: "grp-contractors", identity_provider_id: "idp-entra" } }] }),
				policy({ id: "staff", decision: "allow", precedence: 2, include: [{ email_domain: { domain: "example.com" } }] }),
			]),
			user({ email: "c@example.com" }),
			ctx,
		);
		expect(r.verdict).toBe("depends");
		expect(r.undecided.map((t) => t.policy.id)).toEqual(["entra"]);
		expect(r.decidedBy?.policy.id).toBe("staff");
	});

	it("decides the same policy once the groups are entered", () => {
		const policies = [policy({ decision: "deny", include: [{ azureAD: { id: "grp-contractors", identity_provider_id: "idp-entra" } }] })];
		expect(evaluateAccess(app(policies), user({ idpGroups: ["grp-contractors"] }), ctx).verdict).toBe("blocked");
		expect(evaluateAccess(app(policies), user({ idpGroups: ["grp-staff"] }), ctx).verdict).toBe("denied-default");
	});

	it("treats a truncated list as unknown when the email is not in the part read", () => {
		const big = buildEvalContext([], [{ ...lists[0], count: 900, items_truncated: true }], [], {});
		const r = evaluateAccess(app([policy({ include: [{ email_list: { id: LIST_ID } }] })]), user({ email: "z@example.com" }), big);
		expect(r.verdict).toBe("depends");
		expect(r.trace[0].include[0].note).toMatch(/first 2 of 900/);
	});

	it("never claims device posture either way", () => {
		const r = evaluateAccess(app([policy({ include: [{ everyone: {} }], require: [{ device_posture: { integration_uid: "x" } }] })]), user(), ctx);
		expect(r.verdict).toBe("depends");
	});
});

describe("evaluateAccess — service tokens and identity providers", () => {
	const serviceApp = app([
		policy({ id: "svc", decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: "tok-1" } }] }),
		policy({ id: "staff", decision: "allow", precedence: 2, include: [{ email_domain: { domain: "example.com" } }] }),
	]);

	it("admits the named service token through Service Auth", () => {
		expect(evaluateAccess(serviceApp, { mode: "service", serviceTokenId: "tok-1" }, ctx).verdict).toBe("service");
		expect(evaluateAccess(serviceApp, { mode: "service", serviceTokenId: "tok-2" }, ctx).verdict).toBe("denied-default");
	});

	it("never lets a browser login match a service token rule", () => {
		expect(evaluateAccess(serviceApp, user({ email: "a@example.com" }), ctx).decidedBy?.policy.id).toBe("staff");
	});

	it("refuses a login through an identity provider the app does not allow", () => {
		const r = evaluateAccess(app([policy({ include: [{ everyone: {} }] })], { allowed_idps: ["idp-entra"] }), user({ idpId: "idp-otp" }), ctx);
		expect(r.verdict).toBe("idp-not-allowed");
	});

	it("resolves a reusable policy attached by reference", () => {
		const shared = policy({ id: "shared", include: [{ email: { email: "a@example.com" } }] });
		const withShared = buildEvalContext([], [], [], { shared });
		const r = evaluateAccess(app([{ id: "shared", decision: "allow", precedence: 1 }]), user({ email: "a@example.com" }), withShared);
		expect(r.verdict).toBe("allowed");
	});
});

describe("ipMatches", () => {
	it("matches IPv4 CIDR ranges and exact addresses", () => {
		expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
		expect(ipMatches("11.1.2.3", "10.0.0.0/8")).toBe(false);
		expect(ipMatches("192.0.2.1", "192.0.2.1")).toBe(true);
		expect(ipMatches("192.0.2.1", "0.0.0.0/0")).toBe(true);
	});

	it("compares IPv6 exactly and calls an IPv6 range unknown", () => {
		expect(ipMatches("2001:db8::1", "2001:db8::1")).toBe(true);
		expect(ipMatches("2001:db8::1", "2001:db8::/32")).toBe("unknown");
		expect(ipMatches("2001:db8::1", "10.0.0.0/8")).toBe(false);
	});
});

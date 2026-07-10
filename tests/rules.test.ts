import { describe, expect, it } from "vitest";
import { decisionTone, describeRule, formatColumnLabel, resolvePolicy, type RuleContext } from "../web/src/lib/rules";
import type { CfPolicy } from "../web/src/types";

const ctx: RuleContext = {
	groupName: (id) => (id === "grp-1" ? "Engineering" : id),
	idpName: (id) => (id === "idp-1" ? "Okta SSO" : id),
};

describe("describeRule", () => {
	const cases: [unknown, string][] = [
		[{ email: { email: "a@x.com" } }, "Email is a@x.com"],
		[{ email_domain: { domain: "x.com" } }, "Emails ending in @x.com"],
		[{ everyone: {} }, "Everyone"],
		[{ certificate: {} }, "Valid client certificate"],
		[{ ip: { ip: "10.0.0.0/8" } }, "IP in 10.0.0.0/8"],
		[{ group: { id: "grp-1" } }, 'Member of group "Engineering"'],
		[{ geo: { country_code: "TH" } }, "Country is TH"],
		[{ login_method: { id: "idp-1" } }, "Login via Okta SSO"],
		[{ any_valid_service_token: {} }, "Any valid service token"],
		[{ auth_method: { auth_method: "mfa" } }, "Auth method is mfa"],
		[{ "github-organization": { name: "acme", team: "eng" } }, "GitHub org acme team eng"],
		[{ saml: { attribute_name: "role", attribute_value: "admin" } }, "SAML attribute role = admin"],
	];
	for (const [input, expected] of cases) {
		it(expected, () => expect(describeRule(input, ctx)).toBe(expected));
	}

	it("unknown rule type falls back to key: JSON", () => {
		expect(describeRule({ future_thing: { a: 1 } }, ctx)).toBe('future_thing: {"a":1}');
	});

	it("unresolvable group id falls back to the id", () => {
		expect(describeRule({ group: { id: "nope" } }, ctx)).toBe('Member of group "nope"');
	});
});

describe("resolvePolicy", () => {
	const reusableMap: Record<string, CfPolicy> = {
		"reuse-1": { id: "reuse-1", name: "Reusable Allow", decision: "allow", include: [{ everyone: {} }] },
	};

	it("merges account-level definition into id-only references", () => {
		const resolved = resolvePolicy({ id: "reuse-1", name: "Ref" }, reusableMap);
		expect(resolved.include).toHaveLength(1);
		expect(resolved.decision).toBe("allow");
		expect(resolved.name).toBe("Ref"); // policy's own fields win
		expect(resolved.reusable).toBe(true);
	});

	it("leaves policies with their own rules untouched", () => {
		const policy: CfPolicy = { id: "reuse-1", name: "Own", include: [{ email: { email: "a@x.com" } }] };
		expect(resolvePolicy(policy, reusableMap)).toBe(policy);
	});

	it("unknown ids pass through", () => {
		const policy: CfPolicy = { id: "other", name: "X" };
		expect(resolvePolicy(policy, reusableMap)).toBe(policy);
	});
});

describe("decisionTone", () => {
	it("maps decisions to tones", () => {
		expect(decisionTone("allow")).toBe("allow");
		expect(decisionTone("DENY")).toBe("deny");
		expect(decisionTone("bypass")).toBe("warn");
		expect(decisionTone("non_identity")).toBe("neutral");
		expect(decisionTone("service_auth")).toBe("neutral");
	});
});

describe("formatColumnLabel", () => {
	it("special-cases known columns and title-cases the rest", () => {
		expect(formatColumnLabel("updated_at")).toBe("Updated");
		expect(formatColumnLabel("allowed_idps")).toBe("Identity Providers");
		expect(formatColumnLabel("session_duration")).toBe("Session duration");
	});
});

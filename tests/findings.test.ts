import { beforeEach, describe, expect, it } from "vitest";
import {
	clearSectionSnapshots, publishCacheSnapshot, publishWafSnapshot,
	readCacheSnapshot, readWafSnapshot,
} from "../web/src/lib/sectionSnapshot";
import {
	accessFindings,
	cacheFindings,
	countBySeverity,
	groupsFindings,
	groupUsedBy,
	parseSessionDuration,
	policyReferencesGroup,
	sortFindings,
	wafFindings,
	type Finding, reusablePolicyUsedBy } from "../web/src/lib/findings";
import type { CacheAnalysis } from "../web/src/features/cache/types";
import type { RuleReviewRow } from "../web/src/lib/waf/types";
import type { CfApp, CfGroup, CfPolicy } from "../web/src/types";

function app(overrides: Partial<CfApp>): CfApp {
	return { id: "app-1", name: "App One", policies: [], policies_error: false, ...overrides };
}

function policy(overrides: Partial<CfPolicy>): CfPolicy {
	return { id: "pol-1", name: "Policy One", include: [], exclude: [], require: [], ...overrides };
}

describe("accessFindings", () => {
	it("flags a policy reachable by everyone with no require", () => {
		const apps = [app({ policies: [policy({ include: [{ everyone: {} }], require: [] })] })];
		const findings = accessFindings(apps, {});
		expect(findings.some((f) => f.id.startsWith("access:everyone:") && f.severity === "high")).toBe(true);
	});

	it("does not flag a normal policy with a real require rule", () => {
		const apps = [
			app({
				policies: [policy({ include: [{ everyone: {} }], require: [{ email_domain: { domain: "example.com" } }] })],
			}),
		];
		const findings = accessFindings(apps, {});
		expect(findings.some((f) => f.id.startsWith("access:everyone:"))).toBe(false);
	});

	it("flags zero-policy apps as high", () => {
		const apps = [app({ policies: [] })];
		const findings = accessFindings(apps, {});
		expect(findings).toEqual([
			expect.objectContaining({ id: "access:no-policy:app-1", severity: "high" }),
		]);
	});

	it("flags policies_error apps as medium and skips per-policy checks", () => {
		const apps = [app({ policies_error: true, policies: [policy({ include: [{ everyone: {} }] })] })];
		const findings = accessFindings(apps, {});
		expect(findings).toEqual([
			expect.objectContaining({ id: "access:policies-error:app-1", severity: "medium" }),
		]);
	});

	it("flags bypass decisions as medium", () => {
		const apps = [app({ policies: [policy({ decision: "bypass" })] })];
		const findings = accessFindings(apps, {});
		expect(findings.some((f) => f.id.startsWith("access:bypass:") && f.severity === "medium")).toBe(true);
	});

	it("resolves reusable policies before checking rules", () => {
		const reusableMap = { "shared-1": policy({ id: "shared-1", include: [{ everyone: {} }], require: [] }) };
		const apps = [app({ policies: [{ id: "shared-1" } as CfPolicy] })];
		const findings = accessFindings(apps, reusableMap);
		expect(findings.some((f) => f.id.startsWith("access:everyone:"))).toBe(true);
	});

	describe("parseSessionDuration", () => {
		it("parses simple Go-style durations to minutes", () => {
			expect(parseSessionDuration("24h")).toBe(1440);
			expect(parseSessionDuration("730h")).toBe(43800);
			expect(parseSessionDuration("30m")).toBe(30);
			expect(parseSessionDuration("15m")).toBe(15);
		});

		it("parses compound durations", () => {
			expect(parseSessionDuration("1h30m")).toBe(90);
		});

		it("returns null, never 0, for missing or unparseable values", () => {
			expect(parseSessionDuration(undefined)).toBeNull();
			expect(parseSessionDuration(null)).toBeNull();
			expect(parseSessionDuration("")).toBeNull();
			expect(parseSessionDuration("forever")).toBeNull();
			expect(parseSessionDuration("24")).toBeNull();
		});
	});

	describe("long session", () => {
		it("flags over 24h as low", () => {
			const apps = [app({ session_duration: "48h", policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:long-session:app-1", severity: "low" })]),
			);
		});

		it("flags 168h (7 days) or more as medium", () => {
			const apps = [app({ session_duration: "168h", policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:long-session:app-1", severity: "medium" })]),
			);
		});

		it("does not flag exactly 24h", () => {
			const apps = [app({ session_duration: "24h", policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:long-session:"))).toBe(false);
		});

		it("does not flag a missing or unparseable session_duration", () => {
			const apps = [app({ policies: [] }), app({ id: "app-2", session_duration: "bogus", policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:long-session:"))).toBe(false);
		});
	});

	describe("cookie not HttpOnly", () => {
		it("flags http_only_cookie_attribute explicitly false as low", () => {
			const apps = [app({ http_only_cookie_attribute: false, policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:cookie-not-httponly:app-1", severity: "low" })]),
			);
		});

		it("does not flag when the field is undefined", () => {
			const apps = [app({ policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:cookie-not-httponly:"))).toBe(false);
		});

		it("does not flag when the field is explicitly true", () => {
			const apps = [app({ http_only_cookie_attribute: true, policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:cookie-not-httponly:"))).toBe(false);
		});
	});

	describe("CORS wildcard", () => {
		it("flags allow_all_origins with credentials as medium", () => {
			const apps = [app({ cors_headers: { allow_all_origins: true, allow_credentials: true }, policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:cors-wildcard:app-1", severity: "medium" })]),
			);
		});

		it("flags a wildcard in allowed_origins without credentials as low", () => {
			const apps = [app({ cors_headers: { allowed_origins: ["*"] }, policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:cors-wildcard:app-1", severity: "low" })]),
			);
		});

		it("does not flag a specific origin list", () => {
			const apps = [app({ cors_headers: { allowed_origins: ["https://example.com"], allow_credentials: true }, policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:cors-wildcard:"))).toBe(false);
		});

		it("does not flag when cors_headers is absent", () => {
			const apps = [app({ policies: [] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:cors-wildcard:"))).toBe(false);
		});
	});

	describe("broad allow with no require", () => {
		it("flags an allow policy whose include is all broad kinds and require is empty", () => {
			const apps = [
				app({ policies: [policy({ decision: "allow", include: [{ email_domain: { domain: "example.com" } }], require: [] })] }),
			];
			const findings = accessFindings(apps, {});
			expect(findings).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "access:broad-allow:app-1:pol-1", severity: "low" })]),
			);
		});

		it("flags login_method and any_valid_service_token as broad kinds too", () => {
			const apps = [
				app({
					policies: [
						policy({ id: "pol-a", decision: "allow", include: [{ login_method: { id: "idp-1" } }], require: [] }),
						policy({ id: "pol-b", decision: "allow", include: [{ any_valid_service_token: {} }], require: [] }),
					],
				}),
			];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id === "access:broad-allow:app-1:pol-a")).toBe(true);
			expect(findings.some((f) => f.id === "access:broad-allow:app-1:pol-b")).toBe(true);
		});

		it("does not flag when require is non-empty", () => {
			const apps = [
				app({
					policies: [
						policy({
							decision: "allow",
							include: [{ email_domain: { domain: "example.com" } }],
							require: [{ email_domain: { domain: "example.com" } }],
						}),
					],
				}),
			];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:broad-allow:"))).toBe(false);
		});

		it("does not flag when include mixes in a non-broad rule", () => {
			const apps = [
				app({
					policies: [
						policy({
							decision: "allow",
							include: [{ email_domain: { domain: "example.com" } }, { email: { email: "a@example.com" } }],
							require: [],
						}),
					],
				}),
			];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:broad-allow:"))).toBe(false);
		});

		it("does not flag a non-allow decision", () => {
			const apps = [
				app({ policies: [policy({ decision: "deny", include: [{ email_domain: { domain: "example.com" } }], require: [] })] }),
			];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:broad-allow:"))).toBe(false);
		});

		it("is skipped when the policy is already reachable-by-everyone", () => {
			// "everyone" is not a broad kind, so this also documents that the two rules never both
			// fire on the same include list.
			const apps = [app({ policies: [policy({ decision: "allow", include: [{ everyone: {} }], require: [] })] })];
			const findings = accessFindings(apps, {});
			expect(findings.some((f) => f.id.startsWith("access:broad-allow:"))).toBe(false);
			expect(findings.some((f) => f.id.startsWith("access:everyone:"))).toBe(true);
		});
	});
});

describe("policyReferencesGroup / groupUsedBy", () => {
	it("detects a group referenced in include/require/exclude", () => {
		expect(policyReferencesGroup(policy({ include: [{ group: { id: "g1" } }] }), "g1")).toBe(true);
		expect(policyReferencesGroup(policy({ require: [{ group: { id: "g1" } }] }), "g1")).toBe(true);
		expect(policyReferencesGroup(policy({ exclude: [{ group: { id: "g1" } }] }), "g1")).toBe(true);
		expect(policyReferencesGroup(policy({}), "g1")).toBe(false);
	});

	it("finds a group referenced only through a reusable policy", () => {
		// A reusable policy attached to an app arrives as a bare reference with no rules of its
		// own. Matching that raw object finds nothing, so the group used to report as
		// unreferenced — the direction that gets a live group deleted during an audit.
		const groups = [{ id: "g1", name: "IT admins" }];
		const apps = [{ id: "a1", name: "App One", policies: [{ id: "reusable-1" }] } as never];
		const reusableMap = {
			"reusable-1": { id: "reusable-1", name: "Shared", include: [{ group: { id: "g1" } }] },
		};

		expect(groupUsedBy(groups, apps, reusableMap).get("g1")).toEqual(["App One"]);
		// Without the map the reference is invisible; kept explicit so the regression is obvious.
		expect(groupUsedBy(groups, apps).get("g1")).toEqual([]);
	});

	it("does not report a group as unreferenced when only a reusable policy uses it", () => {
		const groups = [{ id: "g1", name: "IT admins" }];
		const apps = [{ id: "a1", name: "App One", policies: [{ id: "reusable-1" }] } as never];
		const reusableMap = {
			"reusable-1": { id: "reusable-1", include: [{ group: { id: "g1" } }] },
		};

		expect(groupsFindings(groups, apps, reusableMap)).toEqual([]);
		expect(groupsFindings(groups, apps).map((f) => f.id)).toEqual(["groups:unreferenced:g1"]);
	});

	it("groupUsedBy maps referencing app names", () => {
		const groups: CfGroup[] = [{ id: "g1", name: "Group 1" }];
		const apps = [app({ policies: [policy({ include: [{ group: { id: "g1" } }] })] })];
		expect(groupUsedBy(groups, apps).get("g1")).toEqual(["App One"]);
	});
});

describe("groupsFindings", () => {
	it("flags an unreferenced group as low", () => {
		const groups: CfGroup[] = [{ id: "g1", name: "Orphan" }];
		const findings = groupsFindings(groups, []);
		expect(findings).toEqual([expect.objectContaining({ id: "groups:unreferenced:g1", severity: "low" })]);
	});

	it("does not flag a referenced group", () => {
		const groups: CfGroup[] = [{ id: "g1", name: "Used" }];
		const apps = [app({ policies: [policy({ include: [{ group: { id: "g1" } }] })] })];
		expect(groupsFindings(groups, apps)).toEqual([]);
	});
});

function ruleRow(overrides: Partial<RuleReviewRow>): RuleReviewRow {
	return {
		id: "rule-1", name: "Rule 1", ruleset: "Custom", rulesetId: "rs-1", type: "custom", level: "account",
		configuredAction: "block", enabled: true, known: true, expression: "", total: 10,
		actions: { block: 10 }, hosts: new Map(), paths: new Map(), times: [], lastSeen: "",
		...overrides,
	};
}

describe("wafFindings", () => {
	it("flags action drift as medium", () => {
		const rows = [ruleRow({ configuredAction: "block", actions: { log: 8, block: 2 } })];
		const findings = wafFindings(rows);
		expect(findings).toEqual([expect.objectContaining({ id: "waf:drift:rule-1", severity: "medium" })]);
	});

	it("does not flag a rule with no drift", () => {
		const rows = [ruleRow({ configuredAction: "block", actions: { block: 10 } })];
		expect(wafFindings(rows)).toEqual([]);
	});
});

function cacheAnalysis(overrides: Partial<CacheAnalysis>): CacheAnalysis {
	return {
		zoneName: "example.com", zoneId: "zone-1", rangeHours: 24, insights: [], health: null,
		versioning: { enabled: false, environments: [], versionZones: [] }, analyticsSource: "path-graphql",
		rules: [], unattributed: null, timeseries: null, zoneTotals: null, hosts: [],
		...overrides,
	};
}

describe("cacheFindings", () => {
	it("maps warn insights to medium and info to low", () => {
		const analysis = cacheAnalysis({ insights: [{ severity: "warn", message: "warn msg" }, { severity: "info", message: "info msg" }] });
		const findings = cacheFindings(analysis);
		expect(findings.find((f) => f.detail === "warn msg")?.severity).toBe("medium");
		expect(findings.find((f) => f.detail === "info msg")?.severity).toBe("low");
	});

	it("flags D/F health grades as medium, leaves A-C alone", () => {
		expect(cacheFindings(cacheAnalysis({ health: { ratio: 40, grade: "F" } })).some((f) => f.id.startsWith("cache:health:"))).toBe(true);
		expect(cacheFindings(cacheAnalysis({ health: { ratio: 40, grade: "D" } })).some((f) => f.id.startsWith("cache:health:"))).toBe(true);
		expect(cacheFindings(cacheAnalysis({ health: { ratio: 95, grade: "A" } })).some((f) => f.id.startsWith("cache:health:"))).toBe(false);
	});
});

describe("sortFindings / countBySeverity", () => {
	it("sorts by severity then source", () => {
		const findings: Finding[] = [
			{ id: "1", severity: "low", title: "", detail: "", source: "cache", href: "" },
			{ id: "2", severity: "high", title: "", detail: "", source: "groups", href: "" },
			{ id: "3", severity: "high", title: "", detail: "", source: "access", href: "" },
			{ id: "4", severity: "medium", title: "", detail: "", source: "waf", href: "" },
		];
		expect(sortFindings(findings).map((f) => f.id)).toEqual(["3", "2", "4", "1"]);
	});

	it("counts findings by severity", () => {
		const findings: Finding[] = [
			{ id: "1", severity: "high", title: "", detail: "", source: "access", href: "" },
			{ id: "2", severity: "high", title: "", detail: "", source: "access", href: "" },
			{ id: "3", severity: "low", title: "", detail: "", source: "groups", href: "" },
		];
		expect(countBySeverity(findings)).toEqual({ high: 2, medium: 0, low: 1 });
	});
});

describe("section snapshots are scoped by account", () => {
	beforeEach(() => clearSectionSnapshots());

	const snap = { events: [], ruleMeta: {} };

	it("returns a snapshot to the account that captured it", () => {
		publishWafSnapshot("acc-A", snap);
		expect(readWafSnapshot("acc-A")).toBe(snap);
	});

	it("withholds it from a different account", () => {
		// Regression: switching customers used to keep serving the previous
		// customer's telemetry, and Findings reported that section as checked.
		publishWafSnapshot("acc-A", snap);
		expect(readWafSnapshot("acc-B")).toBeNull();
	});

	it("republishing for another account replaces rather than accumulates", () => {
		publishWafSnapshot("acc-A", snap);
		const next = { events: [], ruleMeta: {} };
		publishWafSnapshot("acc-B", next);
		expect(readWafSnapshot("acc-B")).toBe(next);
		expect(readWafSnapshot("acc-A")).toBeNull();
	});

	it("clearing drops everything", () => {
		publishWafSnapshot("acc-A", snap);
		publishCacheSnapshot("acc-A", { zoneName: "z" } as never);
		clearSectionSnapshots();
		expect(readWafSnapshot("acc-A")).toBeNull();
		expect(readCacheSnapshot("acc-A")).toBeNull();
	});
});

describe("reusablePolicyUsedBy", () => {
	const policy = (id: string, name: string) => ({ id, name, decision: "allow" });
	const app = (name: string, policyIds: string[]) => ({
		id: `app-${name}`,
		name,
		policies: policyIds.map((id) => ({ id })),
	});

	it("names every application that attaches a policy by reference", () => {
		const map = reusablePolicyUsedBy(
			[policy("p1", "Staff only"), policy("p2", "Contractors")],
			[app("wiki", ["p1"]), app("grafana", ["p1", "p2"])] as never,
		);
		expect(map.get("p1")).toEqual(["wiki", "grafana"]);
		expect(map.get("p2")).toEqual(["grafana"]);
	});

	it("reports an unattached policy as attached to nothing", () => {
		// Worth surfacing: it is either dead configuration, or a policy someone believes is in
		// force. Both are things an operator wants to see on this tab.
		const map = reusablePolicyUsedBy([policy("orphan", "Old vendor access")], [app("wiki", ["p1"])] as never);
		expect(map.get("orphan")).toEqual([]);
	});

	it("keeps an entry for every policy, so a lookup never returns undefined", () => {
		const map = reusablePolicyUsedBy([policy("p1", "One"), policy("p2", "Two")], [] as never);
		expect([...map.keys()].sort()).toEqual(["p1", "p2"]);
	});
});

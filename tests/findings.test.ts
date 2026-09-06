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
	policyReferencesGroup,
	sortFindings,
	wafFindings,
	type Finding,
} from "../web/src/lib/findings";
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

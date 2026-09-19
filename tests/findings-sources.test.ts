import { describe, expect, it } from "vitest";
import { gatewayPoliciesFindings, shieldsFindings } from "../web/src/lib/findings-sources";
import {
	botsFindings, dnsRecordsFindings, pqcFindings, tunnelsFindings, wafEvaluationFindings, zoneHealthFindings,
} from "../web/src/lib/findings-sources";
import type { TunnelMapResult, TunnelSummary, MappingRow } from "../web/src/features/tunnels/types";
import type { ZoneHealthResult } from "../web/src/features/zone-health/types";
import type { PqcResult } from "../web/src/features/pqc/types";
import type { DnsRecordsResult } from "../web/src/features/dns/types";
import type { RatelimitBotResult } from "../web/src/features/bots/types";
import type { RuleMetaEntry, RuleMetaMap } from "../web/src/lib/waf/types";
import { aggregateRules } from "../web/src/lib/waf/aggregate";

// ---------------------------------------------------------------------------
// Tunnels

function tunnel(overrides: Partial<TunnelSummary> = {}): TunnelSummary {
	return {
		id: "t1", name: "prod-tunnel", status: "healthy", colos: [], connectors: [], health: [],
		...overrides,
	};
}

function mappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
	return { hostname: "app.example.com", service: "http://localhost:8080", originKind: "tunnel", ...overrides };
}

describe("tunnelsFindings", () => {
	it("flags an ungated hostname as high", () => {
		const result: TunnelMapResult = {
			tunnels: [], rows: [mappingRow({ gap: "no-access-app" })], privateRoutes: [], errors: [],
		};
		const findings = tunnelsFindings(result);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "high", source: "tunnels", href: "#/tunnels" });
	});

	it("flags a destination with no route as medium", () => {
		const result: TunnelMapResult = {
			tunnels: [], rows: [mappingRow({ gap: "no-tunnel" })], privateRoutes: [], errors: [],
		};
		expect(tunnelsFindings(result)[0].severity).toBe("medium");
	});

	it("does not raise a finding for a row with no gap", () => {
		const result: TunnelMapResult = { tunnels: [], rows: [mappingRow()], privateRoutes: [], errors: [] };
		expect(tunnelsFindings(result)).toEqual([]);
	});

	it("maps a warn-level health note to medium and an info-level one to low", () => {
		const result: TunnelMapResult = {
			tunnels: [
				tunnel({
					health: [
						{ level: "warn", message: "Only one connector is running." },
						{ level: "info", message: "Connectors run different cloudflared versions (2024.1.0, 2024.2.0)." },
					],
				}),
			],
			rows: [],
			privateRoutes: [],
			errors: [],
		};
		const findings = tunnelsFindings(result);
		expect(findings).toHaveLength(2);
		expect(findings.find((f) => f.detail.includes("one connector"))?.severity).toBe("medium");
		expect(findings.find((f) => f.detail.includes("versions"))?.severity).toBe("low");
	});
});

// ---------------------------------------------------------------------------
// Zone Health

function zoneHealthResult(overrides: Partial<ZoneHealthResult["zones"][number]> = {}): ZoneHealthResult {
	return {
		zones: [
			{
				zoneId: "z1",
				zoneName: "example.com",
				certificates: {
					edge: { available: true, items: [] },
					custom: { available: true, items: [] },
					originCa: { available: true, items: [] },
				},
				dns: { findings: [], unknown: [], checked: { records: 0, cnamesResolved: 0, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 } },
				...overrides,
			},
		],
		totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 0 },
		errors: [],
	};
}

describe("zoneHealthFindings", () => {
	it("carries a certificate item's own severity through", () => {
		const result = zoneHealthResult({
			certificates: {
				edge: {
					available: true,
					items: [{ id: "c1", hosts: ["example.com"], expiresOn: "2020-01-01", status: "active", severity: "high", title: "Edge certificate expired", detail: "Expired 100 day(s) ago." }],
				},
				custom: { available: true, items: [] },
				originCa: { available: true, items: [] },
			},
		});
		const findings = zoneHealthFindings(result);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "high", source: "zone-health", href: "#/zone-health" });
	});

	it("skips a certificate item with no severity (informational, not a finding)", () => {
		const result = zoneHealthResult({
			certificates: {
				edge: { available: true, items: [{ id: "c1", hosts: [], expiresOn: "2030-01-01", status: "active", severity: null, title: "", detail: "" }] },
				custom: { available: true, items: [] },
				originCa: { available: true, items: [] },
			},
		});
		expect(zoneHealthFindings(result)).toEqual([]);
	});

	it("never turns an unavailable cert source into a finding", () => {
		const result = zoneHealthResult({
			certificates: {
				edge: { available: false, reason: "Needs SSL and Certificates: Read", items: [] },
				custom: { available: true, items: [] },
				originCa: { available: true, items: [] },
			},
		});
		expect(zoneHealthFindings(result)).toEqual([]);
	});

	it("never turns an unknown DNS check into a finding", () => {
		const result = zoneHealthResult({
			dns: {
				findings: [],
				unknown: [{ record: { name: "a.example.com", type: "CNAME", content: "b.example.com" }, reason: "DNS-over-HTTPS lookup timed out" }],
				checked: { records: 1, cnamesResolved: 0, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
			},
		});
		expect(zoneHealthFindings(result)).toEqual([]);
	});

	it("carries a DNS finding's own severity through", () => {
		const result = zoneHealthResult({
			dns: {
				findings: [{ severity: "high", record: { name: "dead.example.com", type: "CNAME", content: "old-tunnel.cfargotunnel.com" }, title: "Dangling CNAME", detail: "Target does not resolve." }],
				unknown: [],
				checked: { records: 1, cnamesResolved: 1, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
			},
		});
		expect(zoneHealthFindings(result)[0]).toMatchObject({ severity: "high", source: "zone-health" });
	});
});

// ---------------------------------------------------------------------------
// PQC

function pqcResult(overrides: Partial<PqcResult> = {}): PqcResult {
	return {
		rows: [],
		zones: [],
		totals: { hostnames: 0, ready: 0, eligible: 0, notReady: 0, unknown: 0, tlsFindings: 0, validationRecordsExcluded: 0 },
		errors: [],
		tunnelsKnown: true,
		workersKnown: true,
		...overrides,
	};
}

describe("pqcFindings", () => {
	it("flags a not-ready hostname as medium", () => {
		const result = pqcResult({
			rows: [{ zoneId: "z1", zoneName: "example.com", fqdn: "api.example.com", type: "A", proxied: false, inbound: "not-proxied", origin: "unknown", verdict: "not-ready", reasons: ["DNS-only"] }],
		});
		const findings = pqcFindings(result);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "medium", source: "pqc", href: "#/pqc" });
	});

	it("does not flag a ready or eligible hostname", () => {
		const result = pqcResult({
			rows: [
				{ zoneId: "z1", zoneName: "example.com", fqdn: "ready.example.com", type: "A", proxied: true, inbound: "pqc", origin: "tunnel", verdict: "ready", reasons: [] },
				{ zoneId: "z1", zoneName: "example.com", fqdn: "elig.example.com", type: "A", proxied: true, inbound: "pqc", origin: "eligible", verdict: "eligible", reasons: [] },
			],
		});
		expect(pqcFindings(result)).toEqual([]);
	});

	it("downgrades a zone TLS hygiene finding to low regardless of its own severity", () => {
		const result = pqcResult({
			zones: [
				{
					zoneId: "z1", zoneName: "example.com", tls13: "on", minTlsVersion: "1.2", sslMode: "strict",
					ciphers: { mode: "default", suites: [], counts: {} as never, findings: [], supersededByTls13: true },
					tlsFindings: [{ id: "hsts", severity: "high", title: "HSTS not set", detail: "No Strict-Transport-Security header.", remediation: "Enable HSTS." }],
					hostnames: 1, ready: 0, eligible: 0, notReady: 0, unknown: 1, validationRecordsExcluded: 0,
				},
			],
		});
		const findings = pqcFindings(result);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "low", source: "pqc" });
	});
});

// ---------------------------------------------------------------------------
// DNS Records

function dnsRow(overrides: Partial<DnsRecordsResult["rows"][number]> = {}): DnsRecordsResult["rows"][number] {
	return {
		zoneId: "z1", zoneName: "example.com", id: "r1", type: "A", name: "origin.example.com", content: "203.0.113.5",
		proxied: false, proxiable: true, ttl: 1, comment: null, tags: [], modified_on: null, flags: [],
		...overrides,
	};
}

describe("dnsRecordsFindings", () => {
	it("flags an origin-exposed row as medium", () => {
		const result: DnsRecordsResult = {
			rows: [dnsRow({ flags: ["origin-exposed"] })],
			summary: { totalRecords: 1, proxiedCount: 0, dnsOnlyCount: 1, exposedOriginCount: 1, byType: {}, byZone: [] },
			zoneErrors: [],
		};
		const findings = dnsRecordsFindings(result);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "medium", source: "dns", href: "#/dns" });
	});

	it("flags an internal-address row as low", () => {
		const result: DnsRecordsResult = {
			rows: [dnsRow({ content: "10.0.0.5", flags: ["internal-address"] })],
			summary: { totalRecords: 1, proxiedCount: 0, dnsOnlyCount: 1, exposedOriginCount: 0, byType: {}, byZone: [] },
			zoneErrors: [],
		};
		expect(dnsRecordsFindings(result)[0].severity).toBe("low");
	});

	it("does not flag a proxied or unflagged row", () => {
		const result: DnsRecordsResult = {
			rows: [dnsRow({ proxied: true })],
			summary: { totalRecords: 1, proxiedCount: 1, dnsOnlyCount: 0, exposedOriginCount: 0, byType: {}, byZone: [] },
			zoneErrors: [],
		};
		expect(dnsRecordsFindings(result)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Rate Limits & Bots

describe("botsFindings", () => {
	it("passes severities through, mapping info to low", () => {
		const result: RatelimitBotResult = {
			rateLimit: [], botManagement: [],
			findings: [
				{ severity: "high", zoneId: "z1", zoneName: "example.com", title: "Bot protection is off", detail: "..." },
				{ severity: "info", zoneId: "z1", zoneName: "example.com", title: "AI bots not blocked", detail: "..." },
			],
			totals: { zonesChecked: 1, rateLimitRules: 0, zonesWithNoRateLimitRules: 1, botProtectionOn: 0, botProtectionOff: 1, botProtectionUnknown: 0 },
		};
		const findings = botsFindings(result);
		expect(findings.map((f) => f.severity)).toEqual(["high", "low"]);
		expect(findings.every((f) => f.source === "bots" && f.href === "#/bots")).toBe(true);
	});

	it("returns nothing when the report has no findings", () => {
		const result: RatelimitBotResult = {
			rateLimit: [], botManagement: [], findings: [],
			totals: { zonesChecked: 0, rateLimitRules: 0, zonesWithNoRateLimitRules: 0, botProtectionOn: 0, botProtectionOff: 0, botProtectionUnknown: 0 },
		};
		expect(botsFindings(result)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// WAF evaluation order

const rs = (id: string, name: string, kind: string, phase: string, source: string, extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name, source, type: kind === "managed" ? "managed" : "custom", level: source === "account" ? "account" : "zone",
	phase, ruleset: name, rulesetId: id, kind, isRuleset: true, ...extra,
});
const rule = (id: string, rulesetId: string, position: number, action: string, expression = "x", extra: Partial<RuleMetaEntry> = {}): RuleMetaEntry => ({
	name: id, ruleId: id, source: "zone:a.example", type: "custom", level: "zone", phase: "", ruleset: rulesetId, rulesetId,
	kind: "", action, enabled: true, expression, position, ...extra,
});

const CUSTOM = "http_request_firewall_custom";
const MANAGED = "http_request_firewall_managed";

describe("wafEvaluationFindings", () => {
	it("groups rules that never run under one finding per disabled deployment", () => {
		const meta: RuleMetaMap = {
			"z-man": rs("z-man", "zone", "zone", MANAGED, "zone:a.example"),
			"zm-exec": rule("zm-exec", "z-man", 0, "execute", "true", { executes: "cf-managed", phase: MANAGED, enabled: false }),
			"cf-managed": rs("cf-managed", "Cloudflare Managed Ruleset", "managed", MANAGED, "zone:a.example"),
			"m-0": rule("m-0", "cf-managed", 0, "block", "sqli", { type: "managed", phase: MANAGED }),
			"m-1": rule("m-1", "cf-managed", 1, "block", "xss", { type: "managed", phase: MANAGED }),
		};
		const rows = aggregateRules([], meta);
		const findings = wafEvaluationFindings(meta, rows);
		const unreachable = findings.filter((f) => f.title.includes("never run"));
		expect(unreachable).toHaveLength(1);
		expect(unreachable[0]).toMatchObject({ severity: "medium", source: "waf", href: "#/waf?tab=rules" });
		expect(unreachable[0].title).toContain("2 rules never run in a.example");
		expect(unreachable[0].detail).toMatch(/execute rule.*disabled/i);
	});

	it("flags an undeployed ruleset as low", () => {
		const meta: RuleMetaMap = {
			unused: rs("unused", "Never deployed", "custom", CUSTOM, "account"),
			"u-0": rule("u-0", "unused", 0, "block", "x", { phase: CUSTOM }),
		};
		const rows = aggregateRules([], meta);
		const findings = wafEvaluationFindings(meta, rows);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "low", source: "waf" });
		expect(findings[0].title).toContain("Never deployed");
	});

	it("returns nothing when every rule is reachable and every ruleset is deployed", () => {
		const meta: RuleMetaMap = {
			"z-custom": rs("z-custom", "default", "zone", CUSTOM, "zone:a.example"),
			"zc-0": rule("zc-0", "z-custom", 0, "log", "y", { phase: CUSTOM }),
		};
		const rows = aggregateRules([], meta);
		expect(wafEvaluationFindings(meta, rows)).toEqual([]);
	});
});

describe("gatewayPoliciesFindings / shieldsFindings", () => {
	it("maps Gateway findings, folding info into low and naming the rule", () => {
		const out = gatewayPoliciesFindings({
			rules: [], stages: [], totals: { rules: 0, enabled: 0, disabled: 0, byType: { dns: 0, http: 0, l4: 0, dns_resolver: 0 } },
			findings: [
				{ severity: "medium", ruleId: "r1", ruleName: "Allow SaaS", filterType: "http", title: "Allow rule with no identity condition", detail: "d" },
				{ severity: "info", ruleId: null, ruleName: null, filterType: "l4", title: "No network rules", detail: "d" },
			],
		} as never);
		expect(out.map((f) => [f.severity, f.title, f.source, f.href])).toEqual([
			["medium", "Allow SaaS: Allow rule with no identity condition", "gateway-policies", "#/gateway-policies"],
			["low", "No network rules", "gateway-policies", "#/gateway-policies"],
		]);
	});

	it("maps Shields findings per zone with a deep link to that zone", () => {
		const out = shieldsFindings({
			zones: [], totals: {} as never,
			findings: [{ severity: "high", zoneId: "z1", zoneName: "example.com", source: "page-shield", title: "Malicious script", detail: "d" }],
		} as never);
		expect(out).toEqual([
			{ id: "shields:z1:page-shield:0", severity: "high", title: "example.com: Malicious script", detail: "d", source: "shields", href: "#/shields?sh_zone=z1" },
		]);
	});
});

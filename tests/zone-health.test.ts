import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
	buildZoneHealthReport,
	fetchZoneHealthReport,
	isPrivateAddress,
	type DohOutcome,
	type ZhZone,
	type ZoneHealthInputs,
} from "../src/lib/zone-health";

/**
 * Cover for Zone Health: certificate expiry thresholds, and DNS hygiene (dangling tunnel CNAMEs,
 * dangling external CNAMEs via DNS-over-HTTPS, exposed origins, duplicates).
 *
 * The rule under test throughout: a check that could not run is unknown with a reason, never a
 * silent pass. Most cases here assert that shape rather than a specific finding.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });
const auth = { Authorization: "Bearer caller-token" };

const ZONE: ZhZone = { id: "z1", name: "example.com" };
const NOW = new Date("2026-09-14T00:00:00Z");

function daysFromNow(days: number): string {
	return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

const noDoh = async (): Promise<DohOutcome> => ({ kind: "resolved" });

function baseInputs(over: Partial<ZoneHealthInputs> = {}): ZoneHealthInputs {
	return {
		zones: [ZONE],
		certs: new Map([
			[
				ZONE.id,
				{
					edge: { available: true, items: [] },
					custom: { available: true, items: [] },
					originCa: { available: true, items: [] },
				},
			],
		]),
		dnsRaw: [{ zone: ZONE, records: [] }],
		tunnels: { ids: new Set() },
		dohLookup: noDoh,
		errors: [],
		...over,
	};
}

describe("isPrivateAddress", () => {
	const cases: [string, boolean][] = [
		["10.0.0.1", true],
		["10.255.255.255", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["172.15.255.255", false],
		["172.32.0.0", false],
		["192.168.1.1", true],
		["192.169.1.1", false],
		["100.64.0.1", true],
		["100.127.255.255", true],
		["100.63.255.255", false],
		["127.0.0.1", true],
		["169.254.1.1", true],
		["8.8.8.8", false],
		["203.0.113.10", false],
		["::1", true],
		["fc00::1", true],
		["fdff:ffff::1", true],
		["fe80::1", true],
		["fe80::abcd:1234", true],
		["2001:4860:4860::8888", false],
		// IPv4 written in IPv6 notation is judged as the address it carries.
		["::ffff:10.0.0.1", true],
		["::FFFF:192.168.0.5", true],
		["::ffff:8.8.8.8", false],
		["not-an-ip", false],
	];
	for (const [ip, expected] of cases) {
		it(`${ip} -> ${expected}`, () => {
			expect(isPrivateAddress(ip)).toBe(expected);
		});
	}
});

describe("certificate thresholds", () => {
	it("grades an expired managed edge certificate as high", async () => {
		const cert = { id: "c1", hosts: ["example.com"], status: "active", certificates: [{ id: "c1", expires_on: daysFromNow(-1) }] };
		mockCloudflare({ certPacks: [cert] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		const item = result.zones[0].certificates.edge.items[0];
		expect(item.severity).toBe("high");
		expect(item.title).toContain("expired");
	});

	it("grades a managed edge certificate under 7 days as high — not renewing", async () => {
		const cert = { id: "c1", status: "active", certificates: [{ id: "c1", expires_on: daysFromNow(5) }] };
		mockCloudflare({ certPacks: [cert] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		const item = result.zones[0].certificates.edge.items[0];
		expect(item.severity).toBe("high");
		expect(item.title).toContain("not renewing");
	});

	it("grades a managed edge certificate pack that isn't active as medium", async () => {
		const cert = { id: "c1", status: "pending_validation", certificates: [{ id: "c1", expires_on: daysFromNow(60) }] };
		mockCloudflare({ certPacks: [cert] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		const item = result.zones[0].certificates.edge.items[0];
		expect(item.severity).toBe("medium");
	});

	it("reports a pack that never issued a certificate, instead of skipping it for lack of an expiry", async () => {
		// Nothing issued means nothing to grade by date — and skipping it for that reason would make
		// a hostname with no working certificate look like a zone with nothing to report.
		const pack = { id: "p1", hosts: ["shop.example.com"], status: "validation_timed_out", certificates: [] };
		mockCloudflare({ certPacks: [pack] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		const item = result.zones[0].certificates.edge.items[0];
		expect(item.severity).toBe("medium");
		expect(item.title).toContain("has not issued");
		expect(item.detail).toContain("validation_timed_out");
		expect(item.hosts).toEqual(["shop.example.com"]);
	});

	it("raises nothing for an active pack that simply lists no certificates", async () => {
		mockCloudflare({ certPacks: [{ id: "p1", status: "active", certificates: [] }] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(result.zones[0].certificates.edge.items).toEqual([]);
	});

	it("leaves a healthy active managed certificate with no finding", async () => {
		const cert = { id: "c1", status: "active", certificates: [{ id: "c1", expires_on: daysFromNow(90) }] };
		mockCloudflare({ certPacks: [cert] });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(result.zones[0].certificates.edge.items[0].severity).toBeNull();
	});

	it("grades custom certificates on a 14/30 day threshold, not the managed 7/pack-status one", async () => {
		mockCloudflare({ customCerts: [{ id: "cc1", expires_on: daysFromNow(10) }] });
		const under14 = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(under14.zones[0].certificates.custom.items[0].severity).toBe("high");

		mockCloudflare({ customCerts: [{ id: "cc1", expires_on: daysFromNow(20) }] });
		const under30 = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(under30.zones[0].certificates.custom.items[0].severity).toBe("medium");

		mockCloudflare({ customCerts: [{ id: "cc1", expires_on: daysFromNow(40) }] });
		const clean = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(clean.zones[0].certificates.custom.items[0].severity).toBeNull();
	});

	it("grades Origin CA certificates on a 30 day / expired threshold, renewed by hand", async () => {
		mockCloudflare({ originCaCerts: [{ id: "oc1", expires_on: daysFromNow(-2) }] });
		const expired = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(expired.zones[0].certificates.originCa.items[0].severity).toBe("high");

		mockCloudflare({ originCaCerts: [{ id: "oc1", expires_on: daysFromNow(20) }] });
		const soon = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(soon.zones[0].certificates.originCa.items[0].severity).toBe("medium");
	});

	it("reports code 9109 as unavailable, naming the missing scope", async () => {
		mockCloudflare({ certPacksError: { status: 200, code: 9109, message: "Unauthorized to access requested resource" } });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(result.zones[0].certificates.edge.available).toBe(false);
		expect(result.zones[0].certificates.edge.reason).toContain("SSL and Certificates: Read");
	});

	it("reports a bare 403 as unavailable the same way", async () => {
		mockCloudflare({ customCertsError: { status: 403, message: "Forbidden" } });
		const result = await fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW);
		expect(result.zones[0].certificates.custom.available).toBe(false);
		expect(result.zones[0].certificates.custom.reason).toContain("SSL and Certificates: Read");
	});
});

describe("dangling tunnel CNAME", () => {
	const record = (content: string) => ({ zone: ZONE, records: [{ name: "app.example.com", type: "CNAME", content, proxied: true }] });

	it("flags a tunnel UUID absent from the account's tunnel list as high", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("11111111-1111-1111-1111-111111111111.cfargotunnel.com")],
			tunnels: { ids: new Set(["22222222-2222-2222-2222-222222222222"]) },
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toMatchObject([{ severity: "high", title: "Dangling tunnel CNAME" }]);
	});

	it("raises no finding when the tunnel is live", async () => {
		const uuid = "11111111-1111-1111-1111-111111111111";
		const inputs = baseInputs({
			dnsRaw: [record(`${uuid}.cfargotunnel.com`)],
			tunnels: { ids: new Set([uuid]) },
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
		expect(result.zones[0].dns.unknown).toEqual([]);
	});

	it("reports unknown, not a finding, when the tunnel list comes back empty", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("11111111-1111-1111-1111-111111111111.cfargotunnel.com")],
			tunnels: { ids: new Set() },
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
		expect(result.zones[0].dns.unknown).toHaveLength(1);
		expect(result.zones[0].dns.unknown[0].reason).toMatch(/Cloudflare Tunnel: Read/);
	});

	it("reports unknown when the tunnel list could not be read at all", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("11111111-1111-1111-1111-111111111111.cfargotunnel.com")],
			tunnels: { ids: new Set(), error: "Forbidden" },
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.unknown).toHaveLength(1);
		expect(result.zones[0].dns.unknown[0].reason).toContain("Forbidden");
	});
});

describe("dangling external CNAME", () => {
	it("does not report a domain-validation CNAME as a takeover risk, and counts it as skipped", async () => {
		// Measured live: Google's verification target returned NXDOMAIN and was flagged high. The
		// verifier reads the record, not the target — there is nothing to take over.
		const lookups: string[] = [];
		const result = await buildZoneHealthReport(
			baseInputs({
				dnsRaw: [
					{
						zone: ZONE,
						records: [
							{ name: "gv-abc.example.com", type: "CNAME", content: "gv-abc.dv.googlehosted.com", proxied: false },
							{ name: "shop.example.com", type: "CNAME", content: "gone.azurewebsites.net", proxied: false },
						],
					},
				],
				dohLookup: async (target) => {
					lookups.push(target);
					return { kind: "nxdomain" };
				},
			}),
		);
		const dns = result.zones[0].dns;
		expect(lookups).toEqual(["gone.azurewebsites.net"]);
		expect(dns.findings.map((f) => f.record.name)).toEqual(["shop.example.com"]);
		expect(dns.checked.validationCnamesSkipped).toBe(1);
	});

	const record = (content: string) => ({ zone: ZONE, records: [{ name: "shop.example.com", type: "CNAME", content, proxied: true }] });

	it("NXDOMAIN (DoH Status 3) is a high finding", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("gone.azurewebsites.net")],
			dohLookup: async () => ({ kind: "nxdomain" }),
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toMatchObject([{ severity: "high", title: "Dangling external CNAME" }]);
		expect(result.zones[0].dns.checked.cnamesResolved).toBe(1);
	});

	it("a resolving target raises no finding", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("live.azurewebsites.net")],
			dohLookup: async () => ({ kind: "resolved" }),
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
	});

	it("a lookup that could not complete (SERVFAIL, timeout, thrown) is unknown, never a pass", async () => {
		const inputs = baseInputs({
			dnsRaw: [record("flaky.example.net")],
			dohLookup: async () => ({ kind: "unknown", reason: "DNS-over-HTTPS lookup timed out" }),
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
		expect(result.zones[0].dns.unknown).toMatchObject([{ reason: "DNS-over-HTTPS lookup timed out" }]);
	});

	it("skips a CNAME target inside the account's own zones — no lookup, no finding", async () => {
		let called = 0;
		const inputs = baseInputs({
			zones: [ZONE, { id: "z2", name: "other.example.com" }],
			dnsRaw: [record("service.other.example.com")],
			dohLookup: async () => {
				called++;
				return { kind: "resolved" };
			},
		});
		const result = await buildZoneHealthReport(inputs);
		expect(called).toBe(0);
		expect(result.zones[0].dns.findings).toEqual([]);
		expect(result.zones[0].dns.checked.cnamesResolved).toBe(0);
	});

	it("skips records with an underscore label entirely, for every DNS check", async () => {
		const inputs = baseInputs({
			dnsRaw: [
				{
					zone: ZONE,
					records: [
						{ name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1", proxied: false },
						{ name: "_acme-challenge.example.com", type: "CNAME", content: "dangling.example.net", proxied: false },
					],
				},
			],
			dohLookup: async () => ({ kind: "nxdomain" }),
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
		expect(result.zones[0].dns.unknown).toEqual([]);
		expect(result.zones[0].dns.checked.records).toBe(0);
	});

	it("caps DNS-over-HTTPS lookups at 200 per report and counts the rest as skipped", async () => {
		const records = Array.from({ length: 205 }, (_, i) => ({
			name: `host${i}.example.com`,
			type: "CNAME",
			content: `target${i}.external-example.net`,
			proxied: true,
		}));
		let calls = 0;
		const inputs = baseInputs({
			dnsRaw: [{ zone: ZONE, records }],
			dohLookup: async () => {
				calls++;
				return { kind: "resolved" };
			},
		});
		const result = await buildZoneHealthReport(inputs);
		expect(calls).toBe(200);
		expect(result.zones[0].dns.checked.cnamesResolved).toBe(200);
		expect(result.zones[0].dns.checked.cnamesSkippedByCap).toBe(5);
	});
});

describe("origin exposed", () => {
	it("a public DNS-only A record is a medium finding", async () => {
		const inputs = baseInputs({
			dnsRaw: [{ zone: ZONE, records: [{ name: "direct.example.com", type: "A", content: "203.0.113.5", proxied: false }] }],
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toMatchObject([{ severity: "medium", title: "Origin IP published in DNS" }]);
	});

	it("a private DNS-only address is a low finding, not medium", async () => {
		const inputs = baseInputs({
			dnsRaw: [{ zone: ZONE, records: [{ name: "internal.example.com", type: "A", content: "10.0.0.5", proxied: false }] }],
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toMatchObject([{ severity: "low", title: "Private address published in public DNS" }]);
	});

	it("a proxied A record raises nothing — Cloudflare terminates it", async () => {
		const inputs = baseInputs({
			dnsRaw: [{ zone: ZONE, records: [{ name: "app.example.com", type: "A", content: "203.0.113.5", proxied: true }] }],
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.zones[0].dns.findings).toEqual([]);
	});
});

describe("duplicate records", () => {
	it("flags an exact duplicate (name, type, content) as one low finding, not one per row", async () => {
		const inputs = baseInputs({
			dnsRaw: [
				{
					zone: ZONE,
					records: [
						{ name: "dup.example.com", type: "TXT", content: "v=spf1 -all", proxied: false },
						{ name: "dup.example.com", type: "TXT", content: "v=spf1 -all", proxied: false },
						{ name: "dup.example.com", type: "TXT", content: "v=spf1 -all", proxied: false },
					],
				},
			],
		});
		const result = await buildZoneHealthReport(inputs);
		const dupFindings = result.zones[0].dns.findings.filter((f) => f.title === "Duplicate DNS record");
		expect(dupFindings).toHaveLength(1);
		expect(dupFindings[0].severity).toBe("low");
		expect(dupFindings[0].detail).toContain("3");
	});
});

describe("totals", () => {
	it("rolls up findings by severity and counts unknowns, including unavailable certificate sources", async () => {
		const inputs = baseInputs({
			certs: new Map([
				[
					ZONE.id,
					{
						edge: { available: false, reason: "needs scope", items: [] },
						custom: { available: true, items: [] },
						originCa: { available: true, items: [] },
					},
				],
			]),
			dnsRaw: [{ zone: ZONE, records: [{ name: "internal.example.com", type: "A", content: "10.0.0.5", proxied: false }] }],
		});
		const result = await buildZoneHealthReport(inputs);
		expect(result.totals).toEqual({ zones: 1, findings: { high: 0, medium: 0, low: 1 }, unknown: 1 });
	});
});

// ---------------------------------------------------------------------------
// Route

interface CertPackFixture {
	id: string;
	status?: string;
	hosts?: string[];
	certificates?: { id?: string; expires_on?: string }[];
}
interface CustomCertFixture {
	id: string;
	expires_on?: string;
}
interface OriginCaCertFixture {
	id: string;
	expires_on?: string;
}
interface UpstreamErr {
	status: number;
	code?: number;
	message: string;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function list<T>(result: T[]): { success: true; result: T[]; result_info: { total_pages: number } } {
	return { success: true, result, result_info: { total_pages: 1 } };
}
function errBody(err: UpstreamErr) {
	return json({ success: false, errors: [{ message: err.message, code: err.code }] }, err.status === 200 ? 200 : err.status);
}

function mockCloudflare(opts: {
	certPacks?: CertPackFixture[];
	certPacksError?: UpstreamErr;
	customCerts?: CustomCertFixture[];
	customCertsError?: UpstreamErr;
	originCaCerts?: OriginCaCertFixture[];
	originCaCertsError?: UpstreamErr;
	dnsRecords?: { name: string; type: string; content: string; proxied?: boolean }[];
} = {}) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/zones?account.id=")) return json(list([{ id: ZONE.id, name: ZONE.name }]));
		if (url.includes("/cfd_tunnel")) return json(list([]));
		if (url.includes("/ssl/certificate_packs")) {
			if (opts.certPacksError) return errBody(opts.certPacksError);
			return json(list(opts.certPacks ?? []));
		}
		if (url.includes("/custom_certificates")) {
			if (opts.customCertsError) return errBody(opts.customCertsError);
			return json(list(opts.customCerts ?? []));
		}
		if (url.includes("/certificates?zone_id=")) {
			if (opts.originCaCertsError) return errBody(opts.originCaCertsError);
			return json(list(opts.originCaCerts ?? []));
		}
		if (url.includes("/dns_records")) return json(list(opts.dnsRecords ?? []));
		return json(list([]));
	}) as typeof fetch;
}

beforeEach(() => mockCloudflare());
afterEach(() => vi.restoreAllMocks());

describe("GET /api/zone-health/report", () => {
	it("returns zones, totals and errors for an account", async () => {
		const res = await app.request(`/api/zone-health/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { zones: { zoneId: string }[]; totals: { zones: number } } };
		expect(body.result.zones).toHaveLength(1);
		expect(body.result.totals.zones).toBe(1);
	});

	it("rejects a malformed account id before any upstream call", async () => {
		const res = await app.request("/api/zone-health/report?account_id=not-hex", { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/zone-health/report?account_id=${ACCOUNT}`, {}, ENV, ctx());
		expect(res.status).toBe(401);
	});

	it("maps an upstream zones failure to its own status", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "nope" }] }, 403)) as typeof fetch;
		const res = await app.request(`/api/zone-health/report?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(403);
	});
});

describe("request ordering", () => {
	it("fetches the account tunnel list alongside the zone reads rather than before them", async () => {
		// The tunnel list depends on no zone. Awaiting it before the zone fan-out cost a full round
		// trip of wall clock for nothing. Hold every zone read open and check the tunnel list was
		// already asked for while they were waiting.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const requested: string[] = [];
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			requested.push(url);
			if (url.includes("/zones/")) await gate;
			return new Response(JSON.stringify({ success: true, result: [], result_info: { total_pages: 1 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const pending = fetchZoneHealthReport(ACCOUNT, "tok", [ZONE], NOW, noDoh);
		await new Promise((r) => setTimeout(r, 20));
		const tunnelAskedWhileZonesOpen = requested.some((u) => u.includes("/cfd_tunnel"));
		release();
		await pending;

		expect(tunnelAskedWhileZonesOpen).toBe(true);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { buildPqcReport, gradeCipher, summariseCiphers, type DnsRecord, type PqcInputs, type ZoneTls } from "../src/lib/pqc";

/**
 * Cover for post-quantum readiness classification.
 *
 * The failure this page must never produce is a false pass, so most of these assert that a row
 * is NOT reported ready: a grey-cloud record, a zone with TLS 1.3 off, a Flexible origin, and an
 * origin whose post-quantum support Cloudflare does not publish.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token" };

const tls = (over: Partial<ZoneTls> = {}): ZoneTls => ({ tls13: "on", minTlsVersion: "1.2", sslMode: "full", ciphers: [], ...over });
const rec = (over: Partial<DnsRecord> = {}): DnsRecord => ({ name: "app.example.com", type: "A", proxied: true, content: "203.0.113.10", ...over });

function inputs(over: Partial<PqcInputs> = {}): PqcInputs {
	return {
		zones: [{ id: "z1", name: "example.com" }],
		settings: new Map([["z1", tls()]]),
		records: new Map([["z1", [rec()]]]),
		tunnelHosts: new Set<string>(),
		workerHosts: new Set<string>(),
		tunnelsKnown: true,
		workersKnown: true,
		errors: [],
		...over,
	};
}

const only = (over: Partial<PqcInputs> = {}) => buildPqcReport(inputs(over)).rows[0];

describe("verdicts", () => {
	it("reports a proxied Full-mode hostname as eligible, not ready", () => {
		// Automatic key exchange prefers X25519MLKEM768 when the origin supports it, but Cloudflare
		// does not publish that scan result per zone. Calling this "ready" would report a classical
		// origin as compliant, which is the one error this page must not make.
		const row = only();
		expect(row.verdict).toBe("eligible");
		expect(row.inbound).toBe("pqc");
		expect(row.origin).toBe("eligible");
	});

	it("reports a tunnel-served hostname as ready", () => {
		const row = only({ tunnelHosts: new Set(["app.example.com"]) });
		expect(row.verdict).toBe("ready");
		expect(row.origin).toBe("tunnel");
		expect(row.reasons.join(" ")).toMatch(/cloudflared/);
	});

	it("reports a Worker-backed hostname as ready, whether matched by binding or by target", () => {
		expect(only({ workerHosts: new Set(["app.example.com"]) }).verdict).toBe("ready");
		// A CNAME to workers.dev is served by a Worker even though its own name says nothing.
		const byTarget = only({ records: new Map([["z1", [rec({ type: "CNAME", content: "thing.nfr-th.workers.dev" })]]]) });
		expect(byTarget.origin).toBe("cloudflare");
		expect(byTarget.verdict).toBe("ready");
	});

	it("fails a DNS-only record outright rather than counting it as partly covered", () => {
		const row = only({ records: new Map([["z1", [rec({ proxied: false })]]]) });
		expect(row.verdict).toBe("not-ready");
		expect(row.inbound).toBe("not-proxied");
		// Cloudflare sees none of this traffic, so its origin leg is unknown, not plaintext.
		expect(row.origin).toBe("unknown");
	});

	it("fails every hostname in a zone with TLS 1.3 off", () => {
		// Hybrid key agreement is TLS 1.3 only.
		const row = only({ settings: new Map([["z1", tls({ tls13: "off" })]]) });
		expect(row.verdict).toBe("not-ready");
		expect(row.inbound).toBe("tls13-off");
	});

	it("fails a Flexible or Off origin even when the inbound leg is post-quantum", () => {
		for (const mode of ["flexible", "off"]) {
			const row = only({ settings: new Map([["z1", tls({ sslMode: mode })]]) });
			expect(row.inbound).toBe("pqc");
			expect(row.origin).toBe("plaintext");
			expect(row.verdict).toBe("not-ready");
		}
	});

	it("does not let a tunnel origin rescue a zone with TLS 1.3 off", () => {
		const row = only({ settings: new Map([["z1", tls({ tls13: "off" })]]), tunnelHosts: new Set(["app.example.com"]) });
		expect(row.verdict).toBe("not-ready");
	});

	it("reports unreadable settings as unknown rather than assuming the default", () => {
		const row = only({ settings: new Map([["z1", { tls13: null, minTlsVersion: null, sslMode: null, ciphers: null, error: "Authentication error" }]]) });
		expect(row.verdict).toBe("unknown");
		expect(row.inbound).toBe("unknown");
	});
});

describe("inventory", () => {
	it("keeps only record types that can carry proxied HTTP", () => {
		const report = buildPqcReport(
			inputs({
				records: new Map([
					[
						"z1",
						[
							rec({ name: "a.example.com", type: "A" }),
							rec({ name: "b.example.com", type: "AAAA" }),
							rec({ name: "c.example.com", type: "CNAME", content: "origin.example.net" }),
							rec({ name: "example.com", type: "MX", content: "mx.example.com" }),
							rec({ name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1" }),
						],
					],
				]),
			}),
		);
		expect(report.rows.map((r) => r.fqdn).sort()).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
	});

	it("lists worst first, so the gaps are visible without scrolling", () => {
		const report = buildPqcReport(
			inputs({
				records: new Map([
					[
						"z1",
						[
							rec({ name: "ready.example.com" }),
							rec({ name: "grey.example.com", proxied: false }),
							rec({ name: "worker.example.com", type: "CNAME", content: "x.workers.dev" }),
						],
					],
				]),
			}),
		);
		expect(report.rows.map((r) => r.verdict)).toEqual(["not-ready", "eligible", "ready"]);
	});

	it("keeps a zone whose records could not be read, with zero rows and its error", () => {
		// Dropping it would look identical to a zone that genuinely has no hostnames.
		const report = buildPqcReport(
			inputs({
				settings: new Map([["z1", { tls13: null, minTlsVersion: null, sslMode: null, ciphers: null, error: "Authentication error" }]]),
				records: new Map([["z1", []]]),
			}),
		);
		expect(report.zones).toHaveLength(1);
		expect(report.zones[0].error).toBe("Authentication error");
		expect(report.zones[0].hostnames).toBe(0);
	});

	it("totals every verdict and per-zone counts agree with the rows", () => {
		const report = buildPqcReport(
			inputs({
				records: new Map([
					[
						"z1",
						[rec({ name: "a.example.com" }), rec({ name: "b.example.com", proxied: false }), rec({ name: "c.example.com" })],
					],
				]),
			}),
		);
		expect(report.totals).toEqual({ hostnames: 3, ready: 0, eligible: 2, notReady: 1, unknown: 0 });
		const zone = report.zones[0];
		expect(zone.eligible + zone.notReady + zone.ready + zone.unknown).toBe(zone.hostnames);
	});
});

describe("cipher suites", () => {
	it("grades forward secrecy and AEAD independently", () => {
		expect(gradeCipher("ECDHE-ECDSA-AES128-GCM-SHA256").grade).toBe("aead-fs");
		expect(gradeCipher("ECDHE-RSA-CHACHA20-POLY1305").grade).toBe("aead-fs");
		// Forward-secret but CBC: the padding-oracle family.
		expect(gradeCipher("ECDHE-RSA-AES128-SHA256").grade).toBe("legacy-cbc");
		// AEAD but static RSA key exchange — recorded traffic stays readable to whoever later
		// obtains the certificate key, which is the same exposure PQC key agreement closes.
		expect(gradeCipher("AES128-GCM-SHA256").grade).toBe("no-fs");
		expect(gradeCipher("AES256-SHA").grade).toBe("no-fs");
	});

	it("calls out the obsolete families whatever else they carry", () => {
		for (const name of ["DES-CBC3-SHA", "ECDHE-RSA-RC4-SHA", "ECDHE-RSA-DES-CBC3-SHA", "NULL-MD5"]) {
			expect(gradeCipher(name).grade, name).toBe("broken");
		}
	});

	it("marks Cloudflare's AEAD-prefixed names as the unconfigurable TLS 1.3 suites", () => {
		expect(gradeCipher("AEAD-AES128-GCM-SHA256").grade).toBe("tls13");
		expect(gradeCipher("AEAD-CHACHA20-POLY1305-SHA256").note).toMatch(/not configurable/);
	});

	it("treats an empty list as Cloudflare's defaults and does not grade it", () => {
		// Customising needs Advanced Certificate Manager, and the defaults are not visible through
		// the API — grading a zone down for a list it cannot see would be noise.
		const summary = summariseCiphers([], "1.2");
		expect(summary.mode).toBe("default");
		expect(summary.findings).toEqual([]);
		expect(summary.suites).toEqual([]);
	});

	it("separates an unreadable setting from an empty one", () => {
		expect(summariseCiphers(null, null).mode).toBe("unreadable");
	});

	it("counts and reports what a custom list allows", () => {
		const summary = summariseCiphers(
			["ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES128-SHA", "AES128-GCM-SHA256", "DES-CBC3-SHA"],
			"1.2",
		);
		expect(summary.mode).toBe("custom");
		expect(summary.counts).toMatchObject({ "aead-fs": 1, "legacy-cbc": 1, "no-fs": 1, broken: 1 });
		expect(summary.findings[0]).toMatch(/obsolete/i);
		expect(summary.findings.some((f) => /forward secrecy/i.test(f))).toBe(true);
	});

	it("says a custom list is unreachable when the zone floor is already TLS 1.3", () => {
		// Cipher suite selection applies to TLS 1.0-1.2 only.
		const summary = summariseCiphers(["ECDHE-RSA-AES128-SHA"], "1.3");
		expect(summary.supersededByTls13).toBe(true);
		expect(summary.findings.some((f) => /1\.3/.test(f))).toBe(true);
	});

	it("carries the summary onto the zone, and cipher posture never moves a hostname verdict", () => {
		const weak = buildPqcReport(inputs({ settings: new Map([["z1", tls({ ciphers: ["AES128-GCM-SHA256"] })]]) }));
		const clean = buildPqcReport(inputs());
		expect(weak.zones[0].ciphers.counts["no-fs"]).toBe(1);
		// Same verdict either way: ciphers are TLS 1.2 and below, key agreement is TLS 1.3.
		expect(weak.rows[0].verdict).toBe(clean.rows[0].verdict);
	});
});

// --- the route ------------------------------------------------------------

const list = (result: unknown[]) => ({ success: true, result, result_info: { total_pages: 1 } });

function mockUpstream(opts: { dnsStatus?: number } = {}) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

		if (url.includes("/zones?") || url.includes("/zones&")) return json(list([{ id: "z1", name: "example.com" }]));
		if (url.includes("/settings")) {
			return json(
				list([
					{ id: "tls_1_3", value: "on" },
					{ id: "min_tls_version", value: "1.2" },
					{ id: "ssl", value: "flexible" },
					{ id: "ciphers", value: ["ECDHE-RSA-AES128-GCM-SHA256", "AES128-SHA"] },
				]),
			);
		}
		if (url.includes("/dns_records")) {
			if (opts.dnsStatus && opts.dnsStatus !== 200) {
				return json({ success: false, errors: [{ message: "Authentication error" }] }, opts.dnsStatus);
			}
			return json(list([{ name: "app.example.com", type: "A", proxied: true, content: "203.0.113.10" }]));
		}
		if (url.includes("/cfd_tunnel")) return json(list([]));
		if (url.includes("/workers/domains")) return json(list([]));
		return json(list([]));
	}) as typeof fetch;
}

beforeEach(() => mockUpstream());
afterEach(() => vi.restoreAllMocks());

describe("GET /api/pqc/report", () => {
	it("returns rows, zone summaries and totals", async () => {
		const res = await app.request(`/api/pqc/report?account_id=${ACCOUNT}`, { headers: auth }, ENV);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as { result: { rows: { fqdn: string; verdict: string }[]; totals: { hostnames: number } } };
		expect(body.result.rows).toHaveLength(1);
		// Flexible mode: the origin leg is plain HTTP, so this cannot pass however good the front is.
		expect(body.result.rows[0]).toMatchObject({ fqdn: "app.example.com", verdict: "not-ready" });
		expect(body.result.totals.hostnames).toBe(1);
	});

	it("carries each zone's cipher posture", async () => {
		const res = await app.request(`/api/pqc/report?account_id=${ACCOUNT}`, { headers: auth }, ENV);
		const body = (await res.json()) as { result: { zones: { ciphers: { mode: string; counts: Record<string, number> } }[] } };
		const ciphers = body.result.zones[0].ciphers;
		expect(ciphers.mode).toBe("custom");
		expect(ciphers.counts).toMatchObject({ "aead-fs": 1, "no-fs": 1 });
	});

	it("rejects a malformed account id before any upstream call", async () => {
		const res = await app.request("/api/pqc/report?account_id=not-hex", { headers: auth }, ENV);
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/pqc/report?account_id=${ACCOUNT}`, {}, ENV);
		expect(res.status).toBe(401);
	});

	it("keeps the zone and states the failure when DNS records cannot be read", async () => {
		// The token may lack Zone: DNS: Read. An empty report would read as a clean account.
		mockUpstream({ dnsStatus: 403 });
		const res = await app.request(`/api/pqc/report?account_id=${ACCOUNT}`, { headers: auth }, ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { rows: unknown[]; errors: { source: string; message: string }[] } };
		expect(body.result.rows).toHaveLength(0);
		expect(body.result.errors.some((e) => e.source.includes("DNS records"))).toBe(true);
	});
});

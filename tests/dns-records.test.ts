import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { buildDnsRecordsReport, formatTtl, isAutoTtl, type CfDnsRecordRaw, type DnsZoneRaw } from "../src/lib/dns-records";
import { ctx } from "./helpers/execution-context";

/**
 * Cover for DNS Records: the pure builder (flags, TTL formatting, per-zone errors, summary) and
 * the account-scoped route wired to it.
 *
 * Rule under test throughout: a zone whose DNS read fails is reported with its reason, never
 * silently dropped — a missing zone would read as "zero records here", which is a different fact.
 */

const ACCOUNT = "11111111111111111111111111111111";
const auth = { Authorization: "Bearer caller-token" };
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };

const ZONE_A = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "example.com" };
const ZONE_B = { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "other.example" };

function rec(over: Partial<CfDnsRecordRaw> = {}): CfDnsRecordRaw {
	return {
		id: "r1",
		type: "A",
		name: "www.example.com",
		content: "203.0.113.10",
		proxied: true,
		proxiable: true,
		ttl: 1,
		comment: null,
		tags: [],
		modified_on: "2026-01-01T00:00:00Z",
		...over,
	};
}

describe("TTL formatting", () => {
	it("treats TTL 1 as automatic", () => {
		expect(isAutoTtl(1)).toBe(true);
		expect(formatTtl(1)).toBe("Auto");
	});

	it("renders a real TTL in seconds, never '1s'", () => {
		expect(isAutoTtl(300)).toBe(false);
		expect(formatTtl(300)).toBe("300s");
	});
});

describe("buildDnsRecordsReport", () => {
	it("flags a DNS-only, proxiable A record as origin-exposed", () => {
		const raws: DnsZoneRaw[] = [
			{ zone: ZONE_A, records: [rec({ id: "r1", type: "A", proxied: false, proxiable: true, content: "203.0.113.10" })] },
		];
		const result = buildDnsRecordsReport(raws);
		expect(result.rows[0].flags).toEqual(["origin-exposed"]);
		expect(result.summary.exposedOriginCount).toBe(1);
	});

	it("does not flag a proxied record", () => {
		const raws: DnsZoneRaw[] = [{ zone: ZONE_A, records: [rec({ proxied: true, proxiable: true })] }];
		const result = buildDnsRecordsReport(raws);
		expect(result.rows[0].flags).toEqual([]);
	});

	it("does not flag a DNS-only record that isn't proxiable", () => {
		const raws: DnsZoneRaw[] = [{ zone: ZONE_A, records: [rec({ proxied: false, proxiable: false })] }];
		const result = buildDnsRecordsReport(raws);
		expect(result.rows[0].flags).toEqual([]);
	});

	it("does not flag a non-A/AAAA record even when DNS-only and proxiable", () => {
		const raws: DnsZoneRaw[] = [{ zone: ZONE_A, records: [rec({ type: "CNAME", proxied: false, proxiable: true, content: "target.example.net" })] }];
		const result = buildDnsRecordsReport(raws);
		expect(result.rows[0].flags).toEqual([]);
	});

	it("keeps a zone that failed to read, with its reason, rather than dropping it", () => {
		const raws: DnsZoneRaw[] = [
			{ zone: ZONE_A, records: [rec()] },
			{ zone: ZONE_B, records: [], error: "Authentication error (10000)" },
		];
		const result = buildDnsRecordsReport(raws);
		expect(result.zoneErrors).toEqual([{ zoneId: ZONE_B.id, zoneName: ZONE_B.name, reason: "Authentication error (10000)" }]);
		// The failed zone contributes nothing to the row count, but it is still counted separately
		// from a zone that was read and genuinely has zero records.
		expect(result.rows.every((r) => r.zoneId !== ZONE_B.id)).toBe(true);
	});

	it("distinguishes a zone with zero records from a zone that could not be read", () => {
		const raws: DnsZoneRaw[] = [
			{ zone: ZONE_A, records: [] },
			{ zone: ZONE_B, records: [], error: "Forbidden" },
		];
		const result = buildDnsRecordsReport(raws);
		expect(result.summary.byZone).toContainEqual({ zoneId: ZONE_A.id, zoneName: ZONE_A.name, count: 0 });
		expect(result.zoneErrors).toContainEqual({ zoneId: ZONE_B.id, zoneName: ZONE_B.name, reason: "Forbidden" });
	});

	it("builds a summary of counts per type, proxied vs DNS-only, and per zone", () => {
		const raws: DnsZoneRaw[] = [
			{
				zone: ZONE_A,
				records: [
					rec({ id: "r1", type: "A", proxied: true }),
					rec({ id: "r2", type: "A", proxied: false, proxiable: false, content: "10.0.0.1" }),
					rec({ id: "r3", type: "CNAME", proxied: false, proxiable: false, content: "target.example.net" }),
				],
			},
		];
		const result = buildDnsRecordsReport(raws);
		expect(result.summary.totalRecords).toBe(3);
		expect(result.summary.proxiedCount).toBe(1);
		expect(result.summary.dnsOnlyCount).toBe(2);
		expect(result.summary.byType).toEqual({ A: 2, CNAME: 1 });
		expect(result.summary.byZone).toEqual([{ zoneId: ZONE_A.id, zoneName: ZONE_A.name, count: 3 }]);
	});

	it("skips a record missing a required field rather than emitting a malformed row", () => {
		const raws: DnsZoneRaw[] = [{ zone: ZONE_A, records: [rec({ id: undefined }), rec({ id: "ok" })] }];
		const result = buildDnsRecordsReport(raws);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].id).toBe("ok");
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

function mockCloudflare(opts: { dnsRecords?: Record<string, CfDnsRecordRaw[]>; dnsError?: string } = {}) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/zones?account.id=")) return json(list([ZONE_A, ZONE_B]));
		const zoneMatch = url.match(/\/zones\/([^/]+)\/dns_records/);
		if (zoneMatch) {
			if (opts.dnsError) return json({ success: false, errors: [{ message: opts.dnsError }] }, 403);
			return json(list(opts.dnsRecords?.[zoneMatch[1]] ?? []));
		}
		return json(list([]));
	}) as typeof fetch;
}

beforeEach(() => mockCloudflare());
afterEach(() => vi.restoreAllMocks());

describe("GET /api/dns/records", () => {
	it("returns rows, summary and zoneErrors for an account", async () => {
		mockCloudflare({ dnsRecords: { [ZONE_A.id]: [rec()], [ZONE_B.id]: [rec({ id: "r2" })] } });
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { rows: { zoneId: string }[]; summary: { totalRecords: number } } };
		expect(body.result.rows).toHaveLength(2);
		expect(body.result.summary.totalRecords).toBe(2);
	});

	it("rejects a malformed account id before any upstream call", async () => {
		const res = await app.request("/api/dns/records?account_id=not-hex", { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects a malformed zone id before any upstream call", async () => {
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}&zone_id=not-hex`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("requires authentication", async () => {
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}`, {}, ENV, ctx());
		expect(res.status).toBe(401);
	});

	it("maps an upstream zones failure to its own status", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "nope" }] }, 403)) as typeof fetch;
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(403);
	});

	it("reports a zone whose DNS read failed, with its reason, instead of dropping it", async () => {
		mockCloudflare({ dnsError: "Authentication error" });
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { zoneErrors: { zoneId: string; reason: string }[] } };
		expect(body.result.zoneErrors).toHaveLength(2);
		expect(body.result.zoneErrors[0].reason).toContain("Authentication error");
	});

	it("filters to a single zone when zone_id is given", async () => {
		mockCloudflare({ dnsRecords: { [ZONE_A.id]: [rec()], [ZONE_B.id]: [rec({ id: "r2" })] } });
		const res = await app.request(`/api/dns/records?account_id=${ACCOUNT}&zone_id=${ZONE_A.id}`, { headers: auth }, ENV, ctx());
		const body = (await res.json()) as { result: { rows: { zoneId: string }[] } };
		expect(body.result.rows.every((r) => r.zoneId === ZONE_A.id)).toBe(true);
	});
});

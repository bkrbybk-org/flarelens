/**
 * DNS Records: every DNS record across the account's zones, flattened into one table.
 *
 * A zone whose DNS read fails is reported with its reason in `zoneErrors`, never dropped —
 * dropping it would make "we could not read this zone" look identical to "this zone has zero
 * records", and those are different facts for an operator scanning for an origin leak.
 */

export interface DnsZone {
	id: string;
	name: string;
}

/** Raw shape as Cloudflare's `GET /zones/:id/dns_records` returns it. */
export interface CfDnsRecordRaw {
	id?: string;
	type?: string;
	name?: string;
	content?: string;
	proxied?: boolean;
	proxiable?: boolean;
	ttl?: number;
	comment?: string | null;
	tags?: string[];
	modified_on?: string;
}

import { isPrivateAddress } from "./zone-health";

/**
 * `origin-exposed`: a public origin address published DNS-only.
 * `internal-address`: a private address published DNS-only — a leak of internal topology rather
 * than of an origin, graded lower, matching Zone Health's reading of the same record.
 */
export type DnsRowFlag = "origin-exposed" | "internal-address";

export interface DnsRow {
	zoneId: string;
	zoneName: string;
	id: string;
	type: string;
	name: string;
	content: string;
	proxied: boolean;
	proxiable: boolean;
	/** Raw seconds from Cloudflare. 1 means "automatic" — render that, never "1s". */
	ttl: number;
	comment: string | null;
	tags: string[];
	modified_on: string | null;
	flags: DnsRowFlag[];
}

export interface DnsZoneCount {
	zoneId: string;
	zoneName: string;
	count: number;
}

export interface DnsSummary {
	totalRecords: number;
	proxiedCount: number;
	dnsOnlyCount: number;
	/** Rows carrying the "origin-exposed" flag. */
	exposedOriginCount: number;
	byType: Record<string, number>;
	byZone: DnsZoneCount[];
}

export interface DnsZoneError {
	zoneId: string;
	zoneName: string;
	reason: string;
}

export interface DnsRecordsResult {
	rows: DnsRow[];
	summary: DnsSummary;
	zoneErrors: DnsZoneError[];
}

export interface DnsZoneRaw {
	zone: DnsZone;
	records: CfDnsRecordRaw[];
	error?: string;
}

/** TTL 1 is Cloudflare's "automatic" sentinel, not a one-second TTL. */
export function isAutoTtl(ttl: number): boolean {
	return ttl === 1;
}

export function formatTtl(ttl: number): string {
	return isAutoTtl(ttl) ? "Auto" : `${ttl}s`;
}

const PROXIABLE_TYPES = new Set(["A", "AAAA"]);

/**
 * DNS-only A/AAAA record whose target could instead be proxied. Cloudflare protects nothing for
 * a record set to DNS-only, so a proxiable one left that way publishes the origin's real address
 * to anyone who resolves it.
 */
function computeFlags(record: CfDnsRecordRaw): DnsRowFlag[] {
	const flags: DnsRowFlag[] = [];
	const type = (record.type || "").toUpperCase();
	if (PROXIABLE_TYPES.has(type) && record.proxiable === true && record.proxied === false && record.content) {
		flags.push(isPrivateAddress(record.content) ? "internal-address" : "origin-exposed");
	}
	return flags;
}

/**
 * Build the DNS Records report from already-fetched zones and raw records.
 *
 * Pure — no network calls — so every flag and the summary/error bookkeeping around it is
 * unit-testable without a mocked Cloudflare client.
 */
export function buildDnsRecordsReport(zoneRaws: DnsZoneRaw[]): DnsRecordsResult {
	const rows: DnsRow[] = [];
	const zoneErrors: DnsZoneError[] = [];
	const byType: Record<string, number> = {};
	const byZone: DnsZoneCount[] = [];
	let proxiedCount = 0;
	let dnsOnlyCount = 0;
	let exposedOriginCount = 0;

	for (const raw of zoneRaws) {
		if (raw.error) {
			zoneErrors.push({ zoneId: raw.zone.id, zoneName: raw.zone.name, reason: raw.error });
			byZone.push({ zoneId: raw.zone.id, zoneName: raw.zone.name, count: 0 });
			continue;
		}

		let zoneCount = 0;
		for (const record of raw.records) {
			if (!record.name || !record.type || !record.id) continue;
			const type = record.type.toUpperCase();
			const proxied = record.proxied === true;
			const flags = computeFlags(record);

			rows.push({
				zoneId: raw.zone.id,
				zoneName: raw.zone.name,
				id: record.id,
				type,
				name: record.name,
				content: record.content || "",
				proxied,
				proxiable: record.proxiable === true,
				ttl: typeof record.ttl === "number" ? record.ttl : 1,
				comment: record.comment ?? null,
				tags: record.tags || [],
				modified_on: record.modified_on || null,
				flags,
			});

			zoneCount++;
			byType[type] = (byType[type] || 0) + 1;
			if (proxied) proxiedCount++;
			else dnsOnlyCount++;
			if (flags.includes("origin-exposed")) exposedOriginCount++;
		}
		byZone.push({ zoneId: raw.zone.id, zoneName: raw.zone.name, count: zoneCount });
	}

	return {
		rows,
		summary: {
			totalRecords: rows.length,
			proxiedCount,
			dnsOnlyCount,
			exposedOriginCount,
			byType,
			byZone,
		},
		zoneErrors,
	};
}

/** Mirrors the shapes in src/lib/dns-records.ts. Redeclared per side, as the other sections do. */

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

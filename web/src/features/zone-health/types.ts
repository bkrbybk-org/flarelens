/** Mirrors the shapes in src/lib/zone-health.ts. Redeclared per side, as the other sections do. */

export type CertSeverity = "high" | "medium";

export interface CertItem {
	id: string;
	hosts: string[];
	expiresOn: string;
	status: string | null;
	severity: CertSeverity | null;
	title: string;
	detail: string;
}

export interface CertSource {
	available: boolean;
	reason?: string;
	items: CertItem[];
}

export interface ZoneCertificates {
	edge: CertSource;
	custom: CertSource;
	originCa: CertSource;
}

export type DnsSeverity = "high" | "medium" | "low";

export interface DnsRecordIdentity {
	name: string;
	type: string;
	content: string;
}

export interface DnsFinding {
	severity: DnsSeverity;
	record: DnsRecordIdentity;
	title: string;
	detail: string;
}

export interface DnsUnknown {
	record: DnsRecordIdentity;
	reason: string;
}

export interface ZoneDns {
	findings: DnsFinding[];
	unknown: DnsUnknown[];
	checked: { records: number; cnamesResolved: number; cnamesSkippedByCap: number; validationCnamesSkipped: number };
}

export interface ZoneHealth {
	zoneId: string;
	zoneName: string;
	certificates: ZoneCertificates;
	dns: ZoneDns;
}

export interface ZoneHealthResult {
	zones: ZoneHealth[];
	totals: { zones: number; findings: { high: number; medium: number; low: number }; unknown: number };
	errors: { source: string; message: string }[];
}

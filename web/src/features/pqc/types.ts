/** Mirrors the shapes in src/lib/pqc.ts. Redeclared per side, as the other sections do. */

export type InboundState = "pqc" | "not-proxied" | "tls13-off" | "unknown";
export type OriginState = "tunnel" | "cloudflare" | "eligible" | "plaintext" | "unknown";
export type Verdict = "ready" | "eligible" | "not-ready" | "unknown";

export interface PqcRow {
	zoneId: string;
	zoneName: string;
	fqdn: string;
	type: string;
	proxied: boolean;
	inbound: InboundState;
	origin: OriginState;
	verdict: Verdict;
	reasons: string[];
}

export type CipherGrade = "aead-fs" | "legacy-cbc" | "no-fs" | "broken" | "tls13";

export interface CipherSuite {
	name: string;
	grade: CipherGrade;
	note: string;
}

export interface CipherSummary {
	mode: "default" | "custom" | "unreadable";
	suites: CipherSuite[];
	counts: Record<CipherGrade, number>;
	findings: string[];
	supersededByTls13: boolean;
}

export type TlsFindingSeverity = "high" | "medium" | "low";

export interface TlsFinding {
	id: string;
	severity: TlsFindingSeverity;
	title: string;
	detail: string;
	remediation: string;
}

export interface PqcZoneSummary {
	zoneId: string;
	zoneName: string;
	tls13: string | null;
	minTlsVersion: string | null;
	sslMode: string | null;
	ciphers: CipherSummary;
	/** Zone-level TLS hygiene findings — a separate axis from key agreement, never a verdict input. */
	tlsFindings: TlsFinding[];
	hostnames: number;
	ready: number;
	eligible: number;
	notReady: number;
	unknown: number;
	/** Underscore-prefixed records (ACME/DNS-validation, e.g. _acme-challenge) excluded from the counts above — not services. */
	validationRecordsExcluded: number;
	error?: string;
}

export interface HostAdoption {
	fqdn: string;
	pqc: number;
	classical: number;
	indeterminate: number;
}

/** Measured adoption, when this account's GraphQL schema can express it. See src/lib/pqc-adoption.ts. */
export interface AdoptionResult {
	available: boolean;
	dimension: string | null;
	candidatesSeen: string[];
	reason: string;
	window: { since: string; until: string } | null;
	hosts: HostAdoption[];
	totals: { pqc: number; classical: number; indeterminate: number };
	errors: { source: string; message: string }[];
}

export interface PqcResult {
	rows: PqcRow[];
	zones: PqcZoneSummary[];
	totals: {
		hostnames: number;
		ready: number;
		eligible: number;
		notReady: number;
		unknown: number;
		tlsFindings: number;
		validationRecordsExcluded: number;
	};
	errors: { source: string; message: string }[];
	tunnelsKnown: boolean;
	workersKnown: boolean;
	/** Optional so an older cached response, or a test fixture, renders without it. */
	adoption?: AdoptionResult;
}

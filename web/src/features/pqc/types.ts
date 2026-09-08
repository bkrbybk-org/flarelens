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

export interface PqcZoneSummary {
	zoneId: string;
	zoneName: string;
	tls13: string | null;
	minTlsVersion: string | null;
	sslMode: string | null;
	hostnames: number;
	ready: number;
	eligible: number;
	notReady: number;
	unknown: number;
	error?: string;
}

export interface PqcResult {
	rows: PqcRow[];
	zones: PqcZoneSummary[];
	totals: { hostnames: number; ready: number; eligible: number; notReady: number; unknown: number };
	errors: { source: string; message: string }[];
	tunnelsKnown: boolean;
	workersKnown: boolean;
}

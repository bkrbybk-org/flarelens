/**
 * Post-quantum readiness per hostname.
 *
 * The question is "which of our names are protected against harvest-now-decrypt-later, and which
 * are not". It has two halves, and Cloudflare answers them in different places:
 *
 *   visitor → Cloudflare   Every proxied hostname on TLS 1.3 is offered the X25519MLKEM768 hybrid
 *                          key agreement. Nothing is configured per zone; what decides it is
 *                          whether the name is proxied at all and whether TLS 1.3 is on.
 *   Cloudflare → origin    Automatic key exchange scans each origin roughly daily and prefers
 *                          X25519MLKEM768 when the origin supports it. Cloudflare does not expose
 *                          the scan result per zone, so this side is reported as ELIGIBLE, never
 *                          as confirmed — except where the origin is a tunnel or Cloudflare
 *                          itself, where the path is known.
 *
 * Two consequences worth stating plainly, because both make a row look worse than an operator
 * expects and both are correct:
 *
 *   - A DNS-only (grey-cloud) record is not a partial pass. Cloudflare terminates no TLS for it,
 *     so no Cloudflare-side key agreement applies at all.
 *   - Flexible or Off SSL mode means the origin leg is plaintext. The inbound half can be as
 *     post-quantum as it likes; the data still crosses the internet unencrypted.
 *
 * The deprecated `origin_post_quantum_encryption` zone API is deliberately not read: Cloudflare
 * documents requests to it as no-ops that do not change key agreement behaviour, so reporting it
 * would be reporting a setting that does nothing.
 */

import { CF_API_BASE as REST_BASE, mapWithConcurrency, restList } from "./cf-rest";
/** Workers allow ~6 simultaneous connections per host; the zone fan-out is two calls per zone. */
const CONCURRENCY = 4;

/** Record types that can carry proxied HTTP traffic. Everything else has no TLS leg to assess. */
const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);

/**
 * An underscore-led label (`_acme-challenge.example.com`, `_6390ec….example.com`) names a
 * DNS-validation record (ACME, DKIM, service discovery), not a hostname anyone browses to.
 * It has no visitor-facing TLS posture, so counting it as "not ready" misreports a report about
 * services as a report about the zone's raw record list. Only a label that STARTS with `_`
 * qualifies — `a_b.example.com` is an ordinary hostname that happens to contain an underscore.
 */
function isValidationRecord(name: string): boolean {
	return name.split(".").some((label) => label.startsWith("_"));
}

export class PqcError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "PqcError";
	}
}

export interface PqcZone {
	id: string;
	name: string;
}

/** The zone settings that decide both legs. Null means the setting could not be read. */
export interface ZoneTls {
	/** "on" | "off" */
	tls13: string | null;
	minTlsVersion: string | null;
	/** "off" | "flexible" | "full" | "strict" | "origin_pull" */
	sslMode: string | null;
	/**
	 * Allowed cipher suites for TLS 1.0-1.2, as configured. Empty means Cloudflare's own defaults
	 * — customising this needs Advanced Certificate Manager, so most zones are empty and that is
	 * not a finding. Null means the setting could not be read at all, which is.
	 */
	ciphers: string[] | null;
	/** "on" | "off". Whether Cloudflare redirects plain HTTP to HTTPS rather than serving it. */
	alwaysUseHttps: string | null;
	/** Parsed from the `security_header` setting's `strict_transport_security` object. */
	hsts: { enabled: boolean; maxAge: number | null; includeSubdomains: boolean; preload: boolean } | null;
	error?: string;
}

export type CipherGrade = "aead-fs" | "legacy-cbc" | "no-fs" | "broken" | "tls13";

export interface CipherSuite {
	name: string;
	grade: CipherGrade;
	/** Why it is graded that way, for the row's tooltip. */
	note: string;
}

export interface CipherSummary {
	/** "default" when the zone has no custom list, so Cloudflare's defaults apply. */
	mode: "default" | "custom" | "unreadable";
	suites: CipherSuite[];
	counts: Record<CipherGrade, number>;
	/** Zone-level observations, worst first. Empty when there is nothing to say. */
	findings: string[];
	/**
	 * True when the list cannot affect any connection: cipher suite selection applies to TLS
	 * 1.0-1.2 only, so a zone whose minimum is already 1.3 negotiates none of these.
	 */
	supersededByTls13: boolean;
}

export interface DnsRecord {
	name: string;
	type: string;
	proxied: boolean;
	/** Record target — the CNAME value or the A/AAAA address. */
	content: string;
}

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
	/** Why the verdict is what it is, in the order it was decided. One sentence per entry. */
	reasons: string[];
}

export interface PqcZoneSummary {
	zoneId: string;
	zoneName: string;
	tls13: string | null;
	minTlsVersion: string | null;
	sslMode: string | null;
	/** Allowed TLS 1.0-1.2 cipher suites, graded. See summariseCiphers. */
	ciphers: CipherSummary;
	/** Zone-level TLS hygiene findings. Separate axis from key agreement — see zoneTlsFindings. */
	tlsFindings: TlsFinding[];
	hostnames: number;
	ready: number;
	eligible: number;
	notReady: number;
	unknown: number;
	/** Underscore-prefixed records (ACME/DNS-validation, e.g. _acme-challenge) excluded from the counts above — not services. */
	validationRecordsExcluded: number;
	/** Set when this zone's settings or records could not be read. */
	error?: string;
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
	/** Per-source failures, so a partial report states what is missing rather than looking complete. */
	errors: { source: string; message: string }[];
	/** False when the tunnel list could not be read, so "tunnel origin" cannot be claimed for any row. */
	tunnelsKnown: boolean;
	/** False when Worker custom domains could not be read. */
	workersKnown: boolean;
}

export interface PqcInputs {
	zones: PqcZone[];
	settings: Map<string, ZoneTls>;
	records: Map<string, DnsRecord[]>;
	/** Hostnames served by a Cloudflare Tunnel ingress rule. */
	tunnelHosts: Set<string>;
	/** Hostnames bound to a Worker, plus anything on a Cloudflare-operated domain. */
	workerHosts: Set<string>;
	tunnelsKnown: boolean;
	workersKnown: boolean;
	errors: { source: string; message: string }[];
}

export function normaliseHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Hostnames whose origin is Cloudflare itself, so there is no public origin leg to secure.
 * Matched on the record target rather than the name: a CNAME to `foo.workers.dev` is served by a
 * Worker even though its own hostname says nothing about that.
 */
const CLOUDFLARE_ORIGIN_SUFFIXES = [".workers.dev", ".pages.dev", ".r2.dev", ".cdn.cloudflarestream.com"];

function isCloudflareOrigin(target: string): boolean {
	const host = normaliseHost(target);
	return CLOUDFLARE_ORIGIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Grade one cipher suite name, in Cloudflare's OpenSSL-style spelling.
 *
 * Two properties matter and they are independent:
 *
 *   forward secrecy   An `ECDHE-`/`DHE-` prefix means the session key is ephemeral, so recording
 *                     today's traffic and stealing the certificate key later does not decrypt it.
 *                     A suite without it is exactly the harvest-now-decrypt-later exposure this
 *                     page is about, quantum computer or not.
 *   AEAD              GCM or ChaCha20-Poly1305 authenticate as they encrypt. The `-SHA`/`-SHA256`
 *                     suites are CBC with a bolted-on MAC, the family every padding-oracle attack
 *                     since BEAST has targeted.
 *
 * `AEAD-` prefixed names are Cloudflare's spelling of the TLS 1.3 suites. They are listed in the
 * compliance sets but cannot be selected: TLS 1.3 ciphers are not configurable.
 */
export function gradeCipher(name: string): CipherSuite {
	const upper = name.trim().toUpperCase();

	if (/RC4|NULL|EXPORT|MD5|DES-CBC3|3DES/.test(upper)) {
		return { name, grade: "broken", note: "Obsolete: RC4, 3DES, export-grade or MD5. Broken in practice, not merely dated." };
	}
	if (upper.startsWith("AEAD-")) {
		return { name, grade: "tls13", note: "A TLS 1.3 suite. Always forward-secret and AEAD, and not configurable — listing it changes nothing." };
	}

	const forwardSecret = upper.startsWith("ECDHE-") || upper.startsWith("DHE-");
	const aead = upper.includes("GCM") || upper.includes("CHACHA20-POLY1305");

	if (!forwardSecret) {
		return {
			name,
			grade: "no-fs",
			note: "Static RSA key exchange: no forward secrecy, so traffic recorded today is readable by anyone who later obtains the certificate's private key.",
		};
	}
	if (!aead) {
		return { name, grade: "legacy-cbc", note: "Forward-secret but CBC rather than AEAD — the mode behind the padding-oracle family of attacks." };
	}
	return { name, grade: "aead-fs", note: "Forward secrecy and AEAD. What a TLS 1.2 suite should be." };
}

const EMPTY_COUNTS: Record<CipherGrade, number> = { "aead-fs": 0, "legacy-cbc": 0, "no-fs": 0, broken: 0, tls13: 0 };

/**
 * Grade a zone's whole list.
 *
 * An empty list is reported as "Cloudflare default" and NOT graded. Cloudflare's defaults are
 * chosen for compatibility and do include CBC suites, but they are Cloudflare's to change, they
 * are not visible through this API, and customising them needs an ACM subscription — grading a
 * zone down for a list it cannot see and may not be entitled to edit would be noise.
 */
export function summariseCiphers(ciphers: string[] | null, minTlsVersion: string | null): CipherSummary {
	if (ciphers === null) {
		return { mode: "unreadable", suites: [], counts: { ...EMPTY_COUNTS }, findings: [], supersededByTls13: false };
	}

	const supersededByTls13 = minTlsVersion === "1.3";
	if (ciphers.length === 0) {
		return {
			mode: "default",
			suites: [],
			counts: { ...EMPTY_COUNTS },
			findings: [],
			supersededByTls13,
		};
	}

	const suites = ciphers.map(gradeCipher).sort((a, b) => a.name.localeCompare(b.name));
	const counts = { ...EMPTY_COUNTS };
	for (const suite of suites) counts[suite.grade]++;

	const findings: string[] = [];
	if (counts.broken) {
		findings.push(`${counts.broken} obsolete suite(s) allowed (RC4, 3DES, export-grade or MD5). Remove them.`);
	}
	if (counts["no-fs"]) {
		findings.push(
			`${counts["no-fs"]} suite(s) with no forward secrecy. A recorded session stays decryptable to whoever later obtains the certificate key — the same exposure post-quantum key agreement exists to close.`,
		);
	}
	if (counts["legacy-cbc"]) {
		findings.push(`${counts["legacy-cbc"]} CBC suite(s) allowed. Forward-secret, but not AEAD.`);
	}
	if (supersededByTls13 && suites.length) {
		findings.push("Minimum TLS version is 1.3, so none of these are reachable: cipher suite selection applies to TLS 1.0-1.2 only.");
	}
	return { mode: "custom", suites, counts, findings, supersededByTls13 };
}

export type TlsFindingSeverity = "high" | "medium" | "low";

export interface TlsFinding {
	id: string;
	severity: TlsFindingSeverity;
	title: string;
	detail: string;
	remediation: string;
}

const HSTS_PRELOAD_FLOOR_SECONDS = 15552000; // 180 days — the minimum preload lists require is a year, so anything short of this narrows the window on purpose.

/**
 * Zone-level TLS hygiene, as a separate axis from PQC readiness.
 *
 * Nothing here can move a verdict: these are configuration choices about the classical TLS
 * handshake (version floor, origin certificate validation, HSTS), not about key agreement. A zone
 * can fail every rule below and still be `ready` on every hostname, and that is correct — grading
 * verdicts on the two axes together would make a config fix look like it improved PQC coverage,
 * which it does not.
 *
 * Each rule reads its own inputs and stays silent on null: a setting that could not be fetched is
 * unknown, and an unknown is never a finding (that would be inventing a fail) nor a pass (the
 * codebase's central rule).
 */
export function zoneTlsFindings(tls: ZoneTls): TlsFinding[] {
	const findings: TlsFinding[] = [];

	if (tls.minTlsVersion === "1.0" || tls.minTlsVersion === "1.1") {
		findings.push({
			id: "min-tls",
			severity: "high",
			title: "Minimum TLS version below 1.2",
			detail: "A client can negotiate down to a TLS version with known weaknesses. PCI DSS requires 1.2 as the floor.",
			remediation: "Raise Minimum TLS Version to 1.2.",
		});
	}

	// Only "full" is flagged here. Flexible/Off are already reported as a plaintext origin leg by
	// the verdict itself, and strict/origin_pull already validate the origin certificate.
	if (tls.sslMode === "full") {
		findings.push({
			id: "ssl-mode-not-strict",
			severity: "medium",
			title: "SSL mode is Full, not Full (strict)",
			detail: "Cloudflare encrypts to the origin but does not validate the origin certificate, so the origin leg is vulnerable to an active machine-in-the-middle.",
			remediation: "Move to Full (strict) once the origin serves a valid certificate.",
		});
	}

	if (tls.hsts !== null && tls.hsts.enabled === false) {
		findings.push({
			id: "hsts-off",
			severity: "medium",
			title: "HSTS is off",
			detail: "Without HSTS a first request over plain HTTP is possible and strippable.",
			remediation: "Enable HSTS.",
		});
	}

	if (tls.hsts !== null && tls.hsts.enabled === true && tls.hsts.maxAge !== null && tls.hsts.maxAge < HSTS_PRELOAD_FLOOR_SECONDS) {
		findings.push({
			id: "hsts-short",
			severity: "low",
			title: "HSTS max-age is short",
			detail: "A short max-age narrows the protection window; preload lists require at least a year.",
			remediation: "Raise HSTS max-age to at least 180 days (15552000 seconds), a year to qualify for preload.",
		});
	}

	if (tls.alwaysUseHttps === "off") {
		findings.push({
			id: "always-https-off",
			severity: "medium",
			title: "Always Use HTTPS is off",
			detail: "Plain HTTP requests are served rather than redirected.",
			remediation: "Turn on Always Use HTTPS.",
		});
	}

	const order: Record<TlsFindingSeverity, number> = { high: 0, medium: 1, low: 2 };
	return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

function classifyInbound(record: DnsRecord, tls: ZoneTls): { state: InboundState; reason: string } {
	if (!record.proxied) {
		return {
			state: "not-proxied",
			reason: "DNS-only record: Cloudflare terminates no TLS for this name, so no Cloudflare key agreement applies.",
		};
	}
	if (tls.tls13 === null) {
		return { state: "unknown", reason: "Zone TLS 1.3 setting could not be read, so the inbound leg cannot be assessed." };
	}
	if (tls.tls13 !== "on") {
		return {
			state: "tls13-off",
			reason: "TLS 1.3 is off for this zone. Hybrid key agreement is TLS 1.3 only, so no connection to this name can be post-quantum.",
		};
	}
	return {
		state: "pqc",
		reason: "Proxied on TLS 1.3, so Cloudflare offers X25519MLKEM768. Whether a given connection uses it is the client's choice.",
	};
}

function classifyOrigin(record: DnsRecord, tls: ZoneTls, inputs: PqcInputs): { state: OriginState; reason: string } {
	const fqdn = normaliseHost(record.name);

	if (inputs.tunnelHosts.has(fqdn)) {
		return {
			state: "tunnel",
			reason: "Served through a Cloudflare Tunnel, whose cloudflared connection uses post-quantum key agreement. Signatures on that path are not post-quantum yet.",
		};
	}
	if (inputs.workerHosts.has(fqdn) || isCloudflareOrigin(record.content)) {
		return { state: "cloudflare", reason: "Origin is Cloudflare itself (Worker, Pages or R2), so there is no public origin leg to secure." };
	}
	// A DNS-only record has no Cloudflare-to-origin leg at all; the visitor reaches the origin
	// directly. Reported as unknown rather than plaintext: what that origin negotiates on its own
	// is outside anything this account can see.
	if (!record.proxied) {
		return { state: "unknown", reason: "Traffic bypasses Cloudflare, so the origin's own TLS is not visible here." };
	}
	if (tls.sslMode === null) {
		return { state: "unknown", reason: "Zone SSL mode could not be read, so the origin leg cannot be assessed." };
	}
	if (tls.sslMode === "off" || tls.sslMode === "flexible") {
		return {
			state: "plaintext",
			reason: `SSL mode is ${tls.sslMode}: Cloudflare reaches this origin over plain HTTP, so the origin leg has no encryption to make post-quantum.`,
		};
	}
	return {
		state: "eligible",
		reason: "SSL mode is full or stricter, so automatic key exchange applies and Cloudflare prefers X25519MLKEM768 when the origin supports it. Cloudflare does not publish that scan result per zone, so this cannot be confirmed from the API.",
	};
}

/**
 * Combine the two legs.
 *
 * `eligible` is a deliberate third state rather than a pass: the origin leg being *allowed* to
 * negotiate post-quantum is not evidence that it does. Collapsing it into "ready" would report a
 * classical origin as compliant, which is the one error this page must not make.
 */
function verdictFor(inbound: InboundState, origin: OriginState): Verdict {
	if (inbound === "not-proxied" || inbound === "tls13-off" || origin === "plaintext") return "not-ready";
	if (inbound === "unknown" || origin === "unknown") return "unknown";
	if (origin === "tunnel" || origin === "cloudflare") return "ready";
	return "eligible";
}

export function buildPqcReport(inputs: PqcInputs): PqcResult {
	const rows: PqcRow[] = [];
	const zones: PqcZoneSummary[] = [];

	for (const zone of inputs.zones) {
		const tls = inputs.settings.get(zone.id) ?? {
			tls13: null,
			minTlsVersion: null,
			sslMode: null,
			ciphers: null,
			alwaysUseHttps: null,
			hsts: null,
			error: "Settings not fetched",
		};
		const proxiableRecords = (inputs.records.get(zone.id) ?? []).filter((r) => PROXIABLE_TYPES.has(r.type.toUpperCase()));
		const validationRecordsExcluded = proxiableRecords.filter((r) => isValidationRecord(r.name)).length;
		const records = proxiableRecords.filter((r) => !isValidationRecord(r.name));
		const summary: PqcZoneSummary = {
			zoneId: zone.id,
			zoneName: zone.name,
			tls13: tls.tls13,
			minTlsVersion: tls.minTlsVersion,
			sslMode: tls.sslMode,
			ciphers: summariseCiphers(tls.ciphers, tls.minTlsVersion),
			tlsFindings: zoneTlsFindings(tls),
			hostnames: 0,
			ready: 0,
			eligible: 0,
			notReady: 0,
			unknown: 0,
			validationRecordsExcluded,
			error: tls.error,
		};

		for (const record of records) {
			const inbound = classifyInbound(record, tls);
			const origin = classifyOrigin(record, tls, inputs);
			const verdict = verdictFor(inbound.state, origin.state);
			rows.push({
				zoneId: zone.id,
				zoneName: zone.name,
				fqdn: normaliseHost(record.name),
				type: record.type.toUpperCase(),
				proxied: record.proxied,
				inbound: inbound.state,
				origin: origin.state,
				verdict,
				reasons: [inbound.reason, origin.reason],
			});
			summary.hostnames++;
			if (verdict === "ready") summary.ready++;
			else if (verdict === "eligible") summary.eligible++;
			else if (verdict === "not-ready") summary.notReady++;
			else summary.unknown++;
		}

		zones.push(summary);
	}

	// Worst verdict first: this page exists to surface what is not covered, so a reader who never
	// scrolls has still seen the gaps.
	const order: Record<Verdict, number> = { "not-ready": 0, unknown: 1, eligible: 2, ready: 3 };
	rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.fqdn.localeCompare(b.fqdn));

	return {
		rows,
		zones,
		totals: {
			hostnames: rows.length,
			ready: rows.filter((r) => r.verdict === "ready").length,
			eligible: rows.filter((r) => r.verdict === "eligible").length,
			notReady: rows.filter((r) => r.verdict === "not-ready").length,
			unknown: rows.filter((r) => r.verdict === "unknown").length,
			tlsFindings: zones.reduce((sum, z) => sum + z.tlsFindings.length, 0),
			validationRecordsExcluded: zones.reduce((sum, z) => sum + z.validationRecordsExcluded, 0),
		},
		errors: inputs.errors,
		tunnelsKnown: inputs.tunnelsKnown,
		workersKnown: inputs.workersKnown,
	};
}




interface CfSetting {
	id?: string;
	value?: unknown;
}

/**
 * All of a zone's settings in one call.
 *
 * Reading `tls_1_3`, `min_tls_version` and `ssl` individually would be three round trips per zone;
 * the list endpoint carries every setting and costs one. A setting absent from the response is
 * left null rather than defaulted, because guessing "on" here would manufacture a pass.
 */
async function fetchZoneTls(zoneId: string, token: string): Promise<ZoneTls> {
	const res = await restList<CfSetting>(`/zones/${zoneId}/settings`, token);
	if (res.error) {
		return { tls13: null, minTlsVersion: null, sslMode: null, ciphers: null, alwaysUseHttps: null, hsts: null, error: res.error };
	}
	const byId = new Map(res.result.filter((s) => s.id).map((s) => [s.id as string, s.value]));
	const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
	// An absent `ciphers` setting is an empty selection — Cloudflare's defaults — not an
	// unreadable one. Null is reserved for "the call failed", which is a different report.
	const cipherValue = byId.get("ciphers");
	const ciphers = Array.isArray(cipherValue) ? cipherValue.filter((c): c is string => typeof c === "string") : [];
	return {
		tls13: str(byId.get("tls_1_3")),
		minTlsVersion: str(byId.get("min_tls_version")),
		sslMode: str(byId.get("ssl")),
		ciphers,
		alwaysUseHttps: str(byId.get("always_use_https")),
		hsts: parseHsts(byId.get("security_header")),
	};
}

/**
 * `security_header` nests HSTS under `strict_transport_security`. Any shape mismatch — the key
 * missing, a wrong type on a field — is reported as null (unreadable), never as a guessed value:
 * a malformed response is not evidence the setting is off, and treating it as "on" would be
 * inventing a pass on data that failed to parse.
 */
function parseHsts(value: unknown): ZoneTls["hsts"] {
	if (typeof value !== "object" || value === null) return null;
	const sts = (value as Record<string, unknown>).strict_transport_security;
	if (typeof sts !== "object" || sts === null) return null;
	const s = sts as Record<string, unknown>;
	if (typeof s.enabled !== "boolean") return null;
	return {
		enabled: s.enabled,
		maxAge: typeof s.max_age === "number" ? s.max_age : null,
		includeSubdomains: s.include_subdomains === true,
		preload: s.preload === true,
	};
}

interface CfDnsRecord {
	name?: string;
	type?: string;
	proxied?: boolean;
	content?: string;
}

interface CfTunnel {
	id: string;
	deleted_at?: string | null;
}

interface CfWorkerDomain {
	hostname?: string;
}

/** Hostnames a tunnel ingress rule serves. Best-effort: without the scope the set is empty. */
async function fetchTunnelHosts(accountId: string, token: string): Promise<{ hosts: Set<string>; known: boolean; error?: string }> {
	const list = await restList<CfTunnel>(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`, token);
	if (list.error) return { hosts: new Set(), known: false, error: list.error };

	const tunnels = list.result.filter((t) => !t.deleted_at);
	const hosts = new Set<string>();
	await mapWithConcurrency(tunnels, CONCURRENCY, async (tunnel) => {
		const response = await fetch(`${REST_BASE}/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		});
		let body: { success?: boolean; result?: { config?: { ingress?: { hostname?: string }[] } } };
		try {
			body = await response.json();
		} catch {
			return;
		}
		if (!response.ok || !body.success) return;
		for (const rule of body.result?.config?.ingress || []) {
			if (rule.hostname) hosts.add(normaliseHost(rule.hostname));
		}
	});
	return { hosts, known: true };
}

/**
 * One account's readiness report.
 *
 * Zone settings and DNS records are fetched per zone with bounded concurrency; a zone that fails
 * either call is still listed, carrying its error, rather than dropped — an absent row would read
 * as "no hostnames here", which is the same shape as a clean result.
 */
export async function fetchPqcReport(accountId: string, token: string, zones: PqcZone[]): Promise<PqcResult> {
	const errors: { source: string; message: string }[] = [];

	const [tunnels, workerDomains] = await Promise.all([
		fetchTunnelHosts(accountId, token),
		restList<CfWorkerDomain>(`/accounts/${accountId}/workers/domains`, token),
	]);
	if (tunnels.error) errors.push({ source: "tunnels", message: tunnels.error });
	if (workerDomains.error) errors.push({ source: "worker domains", message: workerDomains.error });

	const workerHosts = new Set<string>();
	for (const domain of workerDomains.result) {
		if (domain.hostname) workerHosts.add(normaliseHost(domain.hostname));
	}

	const settings = new Map<string, ZoneTls>();
	const records = new Map<string, DnsRecord[]>();

	await mapWithConcurrency(zones, CONCURRENCY, async (zone) => {
		const [tls, dns] = await Promise.all([
			fetchZoneTls(zone.id, token),
			restList<CfDnsRecord>(`/zones/${zone.id}/dns_records`, token),
		]);
		if (tls.error) errors.push({ source: `zone ${zone.name} settings`, message: tls.error });
		settings.set(zone.id, tls);

		if (dns.error) {
			errors.push({ source: `zone ${zone.name} DNS records`, message: dns.error });
			records.set(zone.id, []);
			return;
		}
		records.set(
			zone.id,
			dns.result
				.filter((r) => r.name && r.type)
				.map((r) => ({
					name: r.name as string,
					type: (r.type as string).toUpperCase(),
					proxied: r.proxied === true,
					content: r.content || "",
				})),
		);
	});

	return buildPqcReport({
		zones,
		settings,
		records,
		tunnelHosts: tunnels.hosts,
		workerHosts,
		tunnelsKnown: tunnels.known,
		workersKnown: !workerDomains.error,
		errors,
	});
}

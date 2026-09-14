/**
 * Zone Health: certificate expiry and DNS hygiene.
 *
 * Two independent halves per zone:
 *
 *   Certificates   Three sources Cloudflare exposes separately — edge (managed) certificate
 *                  packs, uploaded custom certificates, and Origin CA certificates — each with its
 *                  own permission and its own renewal story. A managed pack that fails to renew is
 *                  worse than a custom one nearing expiry (nobody is watching it renew itself), so
 *                  the two get different thresholds. Origin CA certs are renewed by hand entirely,
 *                  so they get the widest warning window.
 *   DNS hygiene    Records that point at nothing (a deleted tunnel, a dangling external CNAME —
 *                  the textbook subdomain-takeover setup), an origin IP published where DNS-only
 *                  proxying exposes it, and exact duplicate records.
 *
 * The rule threading through both halves: a check that could not run is reported as unknown with
 * its reason, never folded into "no issues". A 9109 from Cloudflare (missing "SSL and
 * Certificates: Read"), a tunnel list that comes back suspiciously empty, a DNS-over-HTTPS lookup
 * that times out — all of these are absences, and an absence must never render the same as a zero.
 */

const REST_BASE = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 100;
/** Same rationale as pqc.ts: Workers allow ~6 simultaneous connections per host. */
const CONCURRENCY = 5;
/** Total DNS-over-HTTPS lookups this report will make, across every zone. */
const DOH_CAP = 200;
const DOH_TIMEOUT_MS = 3000;

export class ZoneHealthError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "ZoneHealthError";
	}
}

export interface ZhZone {
	id: string;
	name: string;
}

export type CertSeverity = "high" | "medium";

export interface CertItem {
	id: string;
	/** Hostnames the certificate covers, when the source reports them. */
	hosts: string[];
	expiresOn: string;
	/** Pack status for edge certificates; absent for the other two sources. */
	status: string | null;
	/** null means this certificate raised no finding. */
	severity: CertSeverity | null;
	title: string;
	detail: string;
}

export interface CertSource {
	available: boolean;
	/** Set when `available` is false — why this source could not be read. */
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
	checked: { records: number; cnamesResolved: number; cnamesSkippedByCap: number };
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

/**
 * Private address ranges (RFC 1918 + CGNAT + loopback + link-local, and their IPv6 equivalents).
 * A record pointing at one of these is a leaked internal address rather than a leaked origin, so
 * it is graded lower than a public IP published the same way.
 */
export function isPrivateAddress(ip: string): boolean {
	const addr = ip.trim();
	if (addr.includes(":")) {
		// ::ffff:10.0.0.1 is an IPv4 address in IPv6 notation; judge it as the address it carries,
		// or a private address written this way would be graded as a published public origin.
		const mapped = addr.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
		if (mapped) return isPrivateAddress(mapped[1]);
		const groups = parseIPv6(addr);
		if (!groups) return false;
		if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
		const first = groups[0];
		if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
		if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
		return false;
	}

	const match = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!match) return false;
	const [a, b] = match.slice(1, 3).map(Number);
	if ([a, b, ...match.slice(3, 5).map(Number)].some((n) => n < 0 || n > 255)) return false;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local
	return false;
}

function parseIPv6(ip: string): number[] | null {
	const parts = ip.split("::");
	if (parts.length > 2) return null;
	const head = parts[0] ? parts[0].split(":") : [];
	const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return null;
	const groups = [...head, ...Array(missing).fill("0"), ...tail].map((h) => parseInt(h || "0", 16));
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
	return groups;
}

function normaliseHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

function daysUntil(expiresOn: string, now: Date): number {
	const target = Date.parse(expiresOn);
	return Math.floor((target - now.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Certificates

interface CfCertPack {
	id?: string;
	hosts?: string[];
	status?: string;
	certificates?: { id?: string; expires_on?: string; status?: string }[];
}

interface CfCustomCert {
	id?: string;
	hosts?: string[];
	expires_on?: string;
}

interface CfOriginCaCert {
	id?: string;
	hostnames?: string[];
	expires_on?: string;
}

/**
 * Managed edge certificates auto-renew, so a short window is already an operational failure, not
 * just an approaching deadline — the renewal that should have happened did not.
 */
function assessEdgeCert(expiresOn: string, packStatus: string | null, now: Date): { severity: CertSeverity | null; title: string; detail: string } {
	const days = daysUntil(expiresOn, now);
	if (days < 0) {
		return { severity: "high", title: "Edge certificate expired", detail: `Expired ${Math.abs(days)} day(s) ago (${expiresOn}).` };
	}
	if (days < 7) {
		return {
			severity: "high",
			title: "Edge certificate not renewing",
			detail: `Expires in ${days} day(s) (${expiresOn}). Managed certificates auto-renew — this one has not.`,
		};
	}
	if (packStatus && packStatus !== "active") {
		return { severity: "medium", title: "Certificate pack not active", detail: `Pack status is "${packStatus}", not active.` };
	}
	return { severity: null, title: "", detail: "" };
}

/** Uploaded certificates are the operator's own to renew, so the warning window opens earlier. */
function assessCustomCert(expiresOn: string, now: Date): { severity: CertSeverity | null; title: string; detail: string } {
	const days = daysUntil(expiresOn, now);
	if (days < 0) {
		return { severity: "high", title: "Custom certificate expired", detail: `Expired ${Math.abs(days)} day(s) ago (${expiresOn}).` };
	}
	if (days < 14) {
		return { severity: "high", title: "Custom certificate expiring soon", detail: `Expires in ${days} day(s) (${expiresOn}).` };
	}
	if (days < 30) {
		return { severity: "medium", title: "Custom certificate expiring", detail: `Expires in ${days} day(s) (${expiresOn}).` };
	}
	return { severity: null, title: "", detail: "" };
}

/** Origin CA certificates are renewed entirely by hand, so the widest warning window of the three. */
function assessOriginCaCert(expiresOn: string, now: Date): { severity: CertSeverity | null; title: string; detail: string } {
	const days = daysUntil(expiresOn, now);
	if (days < 0) {
		return { severity: "high", title: "Origin CA certificate expired", detail: `Expired ${Math.abs(days)} day(s) ago (${expiresOn}).` };
	}
	if (days < 30) {
		return { severity: "medium", title: "Origin CA certificate expiring", detail: `Expires in ${days} day(s) (${expiresOn}). Renewed by hand — nothing auto-renews this.` };
	}
	return { severity: null, title: "", detail: "" };
}

/**
 * Why a certificate source could not be read.
 *
 * Code 9109 ("Unauthorized to access requested resource") and a bare 401/403 are the same fact
 * from the operator's chair: the bound token lacks "SSL and Certificates: Read". Naming the scope
 * is what turns a cryptic error into something actionable.
 */
function certUnavailableReason(status: number, code: number | undefined, message: string): string {
	if (status === 401 || status === 403 || code === 9109) {
		return 'Needs "SSL and Certificates: Read" — the bound token is not authorized to read this zone\'s certificates.';
	}
	return message || `HTTP ${status}`;
}

interface CfListEnvelopeZh<T> {
	success?: boolean;
	result?: T[];
	errors?: { message?: string; code?: number }[];
	result_info?: { total_pages?: number };
}

async function restListZh<T>(path: string, token: string): Promise<{ result: T[]; error?: string; code?: number; status: number }> {
	const all: T[] = [];
	let page = 1;
	for (;;) {
		const sep = path.includes("?") ? "&" : "?";
		const response = await fetch(`${REST_BASE}${path}${sep}per_page=${PER_PAGE}&page=${page}`, {
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		});
		let body: CfListEnvelopeZh<T>;
		try {
			body = await response.json();
		} catch {
			return { result: [], error: "Cloudflare returned a non-JSON response", status: 502 };
		}
		if (!response.ok || !body.success) {
			return { result: [], error: body.errors?.[0]?.message || `HTTP ${response.status}`, code: body.errors?.[0]?.code, status: response.status };
		}
		all.push(...(body.result || []));
		const totalPages = body.result_info?.total_pages ?? 1;
		if (page >= totalPages || (body.result || []).length === 0) return { result: all, status: 200 };
		page++;
	}
}

async function fetchEdgeCertificates(zoneId: string, token: string, now: Date): Promise<CertSource> {
	const res = await restListZh<CfCertPack>(`/zones/${zoneId}/ssl/certificate_packs?status=all`, token);
	if (res.error) {
		return { available: false, reason: certUnavailableReason(res.status, res.code, res.error), items: [] };
	}
	const items: CertItem[] = [];
	for (const pack of res.result) {
		const certs = pack.certificates && pack.certificates.length > 0 ? pack.certificates : [];
		// A pack stuck in pending_validation or validation_timed_out has issued nothing, so there is
		// no expiry date to grade. Skipping it for that reason would make a hostname with no working
		// certificate look exactly like a zone with nothing to report.
		const issued = certs.some((cert) => cert.expires_on);
		if (!issued && pack.status && pack.status !== "active") {
			items.push({
				id: pack.id || "",
				hosts: pack.hosts || [],
				expiresOn: "",
				status: pack.status,
				severity: "medium",
				title: "Certificate pack has not issued",
				detail: `Pack status is "${pack.status}" and no certificate has been issued for it.`,
			});
			continue;
		}
		for (const cert of certs) {
			if (!cert.expires_on) continue;
			const { severity, title, detail } = assessEdgeCert(cert.expires_on, pack.status ?? null, now);
			items.push({
				id: cert.id || pack.id || "",
				hosts: pack.hosts || [],
				expiresOn: cert.expires_on,
				status: pack.status ?? null,
				severity,
				title,
				detail,
			});
		}
	}
	return { available: true, items };
}

async function fetchCustomCertificates(zoneId: string, token: string, now: Date): Promise<CertSource> {
	const res = await restListZh<CfCustomCert>(`/zones/${zoneId}/custom_certificates`, token);
	if (res.error) {
		return { available: false, reason: certUnavailableReason(res.status, res.code, res.error), items: [] };
	}
	const items: CertItem[] = res.result
		.filter((c) => c.expires_on)
		.map((c) => {
			const { severity, title, detail } = assessCustomCert(c.expires_on as string, now);
			return { id: c.id || "", hosts: c.hosts || [], expiresOn: c.expires_on as string, status: null, severity, title, detail };
		});
	return { available: true, items };
}

async function fetchOriginCaCertificates(zoneId: string, token: string, now: Date): Promise<CertSource> {
	const res = await restListZh<CfOriginCaCert>(`/certificates?zone_id=${zoneId}`, token);
	if (res.error) {
		return { available: false, reason: certUnavailableReason(res.status, res.code, res.error), items: [] };
	}
	const items: CertItem[] = res.result
		.filter((c) => c.expires_on)
		.map((c) => {
			const { severity, title, detail } = assessOriginCaCert(c.expires_on as string, now);
			return { id: c.id || "", hosts: c.hostnames || [], expiresOn: c.expires_on as string, status: null, severity, title, detail };
		});
	return { available: true, items };
}

// ---------------------------------------------------------------------------
// DNS hygiene

interface CfDnsRecordZh {
	name?: string;
	type?: string;
	content?: string;
	proxied?: boolean;
}

interface CfTunnelZh {
	id: string;
	deleted_at?: string | null;
}

/** Hostnames whose any label starts with `_` — TXT/SRV verification records, not operator DNS. */
function isUnderscoreRecord(name: string): boolean {
	return name.split(".").some((label) => label.startsWith("_"));
}

const TUNNEL_CNAME_RE = /^([^.]+)\.cfargotunnel\.com\.?$/i;

export type DohOutcome = { kind: "nxdomain" } | { kind: "resolved" } | { kind: "unknown"; reason: string };

/**
 * DNS-over-HTTPS lookup for one external CNAME target.
 *
 * Measured against a real account: an existing name returns `Status: 0` even with zero answers,
 * and only `Status: 3` (NXDOMAIN) means the name is actually gone. Anything else — a non-3 non-0
 * status, a non-OK HTTP response, a thrown or aborted fetch — is reported as unknown rather than
 * guessed at either direction.
 */
export async function defaultDohLookup(target: string): Promise<DohOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
	try {
		const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(target)}&type=A`, {
			headers: { accept: "application/dns-json" },
			signal: controller.signal,
		});
		if (!response.ok) return { kind: "unknown", reason: `DNS-over-HTTPS returned HTTP ${response.status}` };
		let body: { Status?: number };
		try {
			body = await response.json();
		} catch {
			return { kind: "unknown", reason: "DNS-over-HTTPS returned a non-JSON response" };
		}
		if (body.Status === 3) return { kind: "nxdomain" };
		if (body.Status === 0) return { kind: "resolved" };
		return { kind: "unknown", reason: `DNS-over-HTTPS returned status ${body.Status}` };
	} catch (err) {
		const timedOut = err instanceof Error && err.name === "AbortError";
		return { kind: "unknown", reason: timedOut ? "DNS-over-HTTPS lookup timed out" : "DNS-over-HTTPS lookup failed" };
	} finally {
		clearTimeout(timer);
	}
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

async function fetchDnsRecords(zoneId: string, token: string): Promise<{ records: CfDnsRecordZh[]; error?: string }> {
	const res = await restListZh<CfDnsRecordZh>(`/zones/${zoneId}/dns_records`, token);
	if (res.error) return { records: [], error: res.error };
	return { records: res.result };
}

async function fetchTunnelIds(accountId: string, token: string): Promise<{ ids: Set<string>; error?: string }> {
	const res = await restListZh<CfTunnelZh>(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`, token);
	if (res.error) return { ids: new Set(), error: res.error };
	return { ids: new Set(res.result.filter((t) => !t.deleted_at).map((t) => t.id.toLowerCase())) };
}

interface ZoneDnsRaw {
	zone: ZhZone;
	records: CfDnsRecordZh[];
	error?: string;
}

/**
 * Build every zone's DNS findings.
 *
 * External CNAME resolution is the one step that needs real I/O and a shared budget, so it is
 * gathered across every zone first and looked up in one bounded pass — a per-zone cap would let
 * an account with many small zones make far more than 200 lookups in total.
 */
async function buildDnsForZones(
	zoneRaws: ZoneDnsRaw[],
	ownZoneNames: Set<string>,
	tunnels: { ids: Set<string>; error?: string },
	dohLookup: (target: string) => Promise<DohOutcome>,
): Promise<Map<string, ZoneDns>> {
	interface ExternalCandidate {
		zoneId: string;
		record: DnsRecordIdentity;
	}

	const perZone = new Map<
		string,
		{ findings: DnsFinding[]; unknown: DnsUnknown[]; records: number; cnamesResolved: number; cnamesSkippedByCap: number }
	>();
	const externalCandidates: ExternalCandidate[] = [];

	for (const raw of zoneRaws) {
		const entry = { findings: [] as DnsFinding[], unknown: [] as DnsUnknown[], records: 0, cnamesResolved: 0, cnamesSkippedByCap: 0 };
		perZone.set(raw.zone.id, entry);

		if (raw.error) {
			entry.unknown.push({
				record: { name: "*", type: "*", content: "" },
				reason: `DNS records could not be read: ${raw.error}`,
			});
			continue;
		}

		const records = raw.records.filter((r) => r.name && r.type && !isUnderscoreRecord(r.name as string));
		entry.records = records.length;

		// Exact duplicates: one finding per group, not per occurrence, so a triplicated record
		// reads as one problem rather than three.
		const groups = new Map<string, { record: DnsRecordIdentity; count: number }>();
		for (const record of records) {
			const name = normaliseHost(record.name as string);
			const type = (record.type as string).toUpperCase();
			const content = (record.content || "").trim().toLowerCase();
			const key = `${name}|${type}|${content}`;
			const existing = groups.get(key);
			if (existing) existing.count++;
			else groups.set(key, { record: { name, type, content: record.content || "" }, count: 1 });
		}
		for (const { record, count } of groups.values()) {
			if (count > 1) {
				entry.findings.push({
					severity: "low",
					record,
					title: "Duplicate DNS record",
					detail: `${count} identical records for this name, type and content.`,
				});
			}
		}

		for (const record of records) {
			const type = (record.type as string).toUpperCase();
			const name = normaliseHost(record.name as string);
			const content = record.content || "";
			const identity: DnsRecordIdentity = { name, type, content };

			if (type === "CNAME") {
				const target = normaliseHost(content);
				const tunnelMatch = target.match(TUNNEL_CNAME_RE);
				if (tunnelMatch) {
					const uuid = tunnelMatch[1].toLowerCase();
					if (tunnels.error) {
						entry.unknown.push({ record: identity, reason: `Tunnel list could not be read: ${tunnels.error}` });
					} else if (tunnels.ids.size === 0) {
						entry.unknown.push({
							record: identity,
							reason: 'Tunnel list came back empty — likely missing "Cloudflare Tunnel: Read", so a dangling tunnel cannot be confirmed.',
						});
					} else if (!tunnels.ids.has(uuid)) {
						entry.findings.push({
							severity: "high",
							record: identity,
							title: "Dangling tunnel CNAME",
							detail: `Points at tunnel ${uuid}, which no longer exists in this account.`,
						});
					}
					continue;
				}

				const inAccount = ownZoneNames.has(target) || [...ownZoneNames].some((z) => target.endsWith(`.${z}`));
				if (inAccount) continue;
				if (!target) continue;

				externalCandidates.push({ zoneId: raw.zone.id, record: identity });
				continue;
			}

			if ((type === "A" || type === "AAAA") && record.proxied === false && content) {
				if (isPrivateAddress(content)) {
					entry.findings.push({
						severity: "low",
						record: identity,
						title: "Private address published in public DNS",
						detail: `${content} is a private address, published DNS-only.`,
					});
				} else {
					entry.findings.push({
						severity: "medium",
						record: identity,
						title: "Origin IP published in DNS",
						detail: `${content} is reachable directly — this record is DNS-only, so Cloudflare protects nothing here.`,
					});
				}
			}
		}
	}

	const toLookup = externalCandidates.slice(0, DOH_CAP);
	const capped = externalCandidates.slice(DOH_CAP);
	for (const candidate of capped) {
		const entry = perZone.get(candidate.zoneId);
		if (entry) entry.cnamesSkippedByCap++;
	}

	const results = await mapWithConcurrency(toLookup, CONCURRENCY, async (candidate) => ({
		candidate,
		outcome: await dohLookup(candidate.record.content),
	}));

	for (const { candidate, outcome } of results) {
		const entry = perZone.get(candidate.zoneId);
		if (!entry) continue;
		entry.cnamesResolved++;
		if (outcome.kind === "nxdomain") {
			entry.findings.push({
				severity: "high",
				record: candidate.record,
				title: "Dangling external CNAME",
				detail: `${candidate.record.content} does not exist — subdomain takeover risk.`,
			});
		} else if (outcome.kind === "unknown") {
			entry.unknown.push({ record: candidate.record, reason: outcome.reason });
		}
		// "resolved" raises no finding: the target exists, whatever it answers.
	}

	const out = new Map<string, ZoneDns>();
	for (const [zoneId, entry] of perZone) {
		out.set(zoneId, {
			findings: entry.findings,
			unknown: entry.unknown,
			checked: { records: entry.records, cnamesResolved: entry.cnamesResolved, cnamesSkippedByCap: entry.cnamesSkippedByCap },
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Report assembly

export interface ZoneHealthInputs {
	zones: ZhZone[];
	certs: Map<string, ZoneCertificates>;
	dnsRaw: ZoneDnsRaw[];
	tunnels: { ids: Set<string>; error?: string };
	dohLookup: (target: string) => Promise<DohOutcome>;
	errors: { source: string; message: string }[];
}

export async function buildZoneHealthReport(inputs: ZoneHealthInputs): Promise<ZoneHealthResult> {
	const ownZoneNames = new Set(inputs.zones.map((z) => normaliseHost(z.name)));
	const dnsByZone = await buildDnsForZones(inputs.dnsRaw, ownZoneNames, inputs.tunnels, inputs.dohLookup);

	const zones: ZoneHealth[] = inputs.zones.map((zone) => ({
		zoneId: zone.id,
		zoneName: zone.name,
		certificates: inputs.certs.get(zone.id) ?? {
			edge: { available: false, reason: "Not fetched", items: [] },
			custom: { available: false, reason: "Not fetched", items: [] },
			originCa: { available: false, reason: "Not fetched", items: [] },
		},
		dns: dnsByZone.get(zone.id) ?? { findings: [], unknown: [], checked: { records: 0, cnamesResolved: 0, cnamesSkippedByCap: 0 } },
	}));

	let high = 0;
	let medium = 0;
	let low = 0;
	let unknown = 0;
	for (const zone of zones) {
		for (const source of [zone.certificates.edge, zone.certificates.custom, zone.certificates.originCa]) {
			if (!source.available) {
				unknown++;
				continue;
			}
			for (const item of source.items) {
				if (item.severity === "high") high++;
				else if (item.severity === "medium") medium++;
			}
		}
		for (const finding of zone.dns.findings) {
			if (finding.severity === "high") high++;
			else if (finding.severity === "medium") medium++;
			else low++;
		}
		unknown += zone.dns.unknown.length;
	}

	return {
		zones,
		totals: { zones: zones.length, findings: { high, medium, low }, unknown },
		errors: inputs.errors,
	};
}

/**
 * One account's Zone Health report, fetched fresh from Cloudflare.
 *
 * Certificates and DNS are independent per zone, and the tunnel list is a single account-wide
 * call shared by every zone's dangling-tunnel check — fetched once up front rather than once per
 * zone, the same shape as fetchTunnelHosts in pqc.ts.
 */
export async function fetchZoneHealthReport(
	accountId: string,
	token: string,
	zones: ZhZone[],
	now: Date = new Date(),
	dohLookup: (target: string) => Promise<DohOutcome> = defaultDohLookup,
): Promise<ZoneHealthResult> {
	const errors: { source: string; message: string }[] = [];

	const certs = new Map<string, ZoneCertificates>();
	const dnsRaw: ZoneDnsRaw[] = [];

	// The tunnel list is account-wide and depends on no zone, so it is fetched alongside the
	// per-zone reads rather than ahead of them — waiting for it first costs a round trip for nothing.
	const tunnelsPromise = fetchTunnelIds(accountId, token);
	await mapWithConcurrency(zones, CONCURRENCY, async (zone) => {
		const [edge, custom, originCa, dns] = await Promise.all([
			fetchEdgeCertificates(zone.id, token, now),
			fetchCustomCertificates(zone.id, token, now),
			fetchOriginCaCertificates(zone.id, token, now),
			fetchDnsRecords(zone.id, token),
		]);
		certs.set(zone.id, { edge, custom, originCa });
		if (dns.error) errors.push({ source: `zone ${zone.name} DNS records`, message: dns.error });
		dnsRaw.push({ zone, records: dns.records, error: dns.error });
	});
	const tunnels = await tunnelsPromise;
	if (tunnels.error) errors.push({ source: "tunnels", message: tunnels.error });

	return buildZoneHealthReport({ zones, certs, dnsRaw, tunnels, dohLookup, errors });
}

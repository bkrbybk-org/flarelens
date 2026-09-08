/**
 * Measured post-quantum adoption, if this account's GraphQL schema can express it.
 *
 * The rest of the PQC section reports CONFIGURATION: whether a hostname is proxied, whether
 * TLS 1.3 is on, what the origin leg is. None of that says how many real connections actually
 * negotiated X25519MLKEM768 — that depends on the client, and clients are what is slow to adopt.
 * The measurement exists: Cloudflare added `ClientTLSKeyExchangeGroup` to the `http_requests`
 * Logpush dataset (2026-08-20), with values like `X25519MLKEM768`, `X25519`, `P-256`, `UNK`
 * and `NONE`.
 *
 * Whether the same dimension is queryable through the GraphQL Analytics API — which is the only
 * upstream this Worker talks to — is NOT documented either way, and no amount of reading settles
 * it. So this module asks the schema rather than assuming:
 *
 *   1. Introspect httpRequestsAdaptiveGroups' dimensions.
 *   2. Look for a key-exchange dimension by shape, not by one hardcoded spelling, because the
 *      GraphQL name need not match the Logpush field name (compare `ClientTLSKeyExchangeGroup`
 *      with the existing `clientSSLProtocol`).
 *   3. Found: query it, and report real per-hostname adoption.
 *      Absent: say so, and name the alternative (Log Explorer), rather than showing a zero.
 *
 * A zero and an absence must never look the same — reporting 0% post-quantum traffic for an
 * account whose schema simply cannot answer the question would be the worst output this page
 * could produce.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
/** Per-zone rows for the breakdown. Hostname x key-exchange group stays small. */
const ROW_LIMIT = 2000;

export interface HostAdoption {
	fqdn: string;
	/** Requests that negotiated a post-quantum hybrid key agreement. */
	pqc: number;
	/** Requests over TLS that did not. Excludes rows reporting no TLS at all. */
	classical: number;
	/** Key exchange could not be determined by Cloudflare (`UNK`), or the request used no TLS. */
	indeterminate: number;
}

export interface AdoptionResult {
	/** False when the schema exposes no key-exchange dimension; every other field is then empty. */
	available: boolean;
	/** The dimension actually queried, so a reader can reproduce the number. */
	dimension: string | null;
	/**
	 * Every TLS-ish dimension the probe saw. Present whether or not one matched: when nothing
	 * matched this is the evidence for that claim, and it is what a future spelling change would
	 * show up in.
	 */
	candidatesSeen: string[];
	/** Stated reason when unavailable. Empty when available. */
	reason: string;
	window: { since: string; until: string } | null;
	hosts: HostAdoption[];
	totals: { pqc: number; classical: number; indeterminate: number };
	/** Per-zone failures. A zone that could not be read is named rather than silently missing. */
	errors: { source: string; message: string }[];
}

export function emptyAdoption(reason: string, candidatesSeen: string[] = []): AdoptionResult {
	return {
		available: false,
		dimension: null,
		candidatesSeen,
		reason,
		window: null,
		hosts: [],
		totals: { pqc: 0, classical: 0, indeterminate: 0 },
		errors: [],
	};
}

interface TypeRef {
	name: string | null;
	ofType: TypeRef | null;
}

function unwrap(type: TypeRef | null | undefined): string | null {
	let cursor: TypeRef | null | undefined = type;
	while (cursor) {
		if (cursor.name) return cursor.name;
		cursor = cursor.ofType;
	}
	return null;
}

const TYPE_REF = "name ofType { name ofType { name ofType { name ofType { name } } } }";

const ZONE_FIELDS_QUERY = `
query ProbeZone {
  __type(name: "zone") {
    fields { name type { ${TYPE_REF} } }
  }
}`;

const TYPE_FIELDS_QUERY = `
query ProbeType($name: String!) {
  __type(name: $name) { fields { name type { ${TYPE_REF} } } }
}`;

interface FieldsResponse {
	__type: { fields: { name: string; type: TypeRef }[] | null } | null;
}

async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
	const response = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	let body: { data?: T; errors?: { message?: string }[] };
	try {
		body = await response.json();
	} catch {
		return { error: "Cloudflare returned a non-JSON response" };
	}
	if (body.errors?.length) return { error: body.errors[0]?.message || "GraphQL error" };
	if (!response.ok) return { error: `HTTP ${response.status}` };
	return { data: body.data };
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Dimensions worth showing a human when nothing matches — anything naming TLS, SSL, a cipher or
 * a key exchange. Kept deliberately wider than the match below so the "not available" answer
 * carries evidence rather than just an assertion.
 */
function tlsIsh(dimensions: string[]): string[] {
	return dimensions.filter((d) => /ssl|tls|cipher|keyexchange|kex|curve|group/.test(norm(d)));
}

/**
 * Match by shape, not by one spelling: any dimension naming a key exchange or key agreement.
 * `clientSSLProtocol` and `clientSSLCipher` are deliberately NOT matched — a cipher suite is not
 * a key agreement, and reporting cipher data as post-quantum adoption would be wrong rather than
 * merely imprecise.
 */
function findKeyExchangeDimension(dimensions: string[]): string | null {
	return dimensions.find((d) => /keyexchange|keyagreement|keyshare/.test(norm(d))) ?? null;
}

/** Introspect httpRequestsAdaptiveGroups and report whether adoption is measurable here. */
export async function probeAdoptionDimension(token: string): Promise<{ dimension: string | null; candidates: string[]; error?: string }> {
	const zone = await graphql<FieldsResponse>(token, ZONE_FIELDS_QUERY);
	if (zone.error || !zone.data) return { dimension: null, candidates: [], error: zone.error ?? "no schema returned" };

	const dataset = zone.data.__type?.fields?.find((f) => f.name === "httpRequestsAdaptiveGroups");
	const datasetType = unwrap(dataset?.type);
	if (!datasetType) return { dimension: null, candidates: [], error: "httpRequestsAdaptiveGroups is not in this schema" };

	const rowType = await graphql<FieldsResponse>(token, TYPE_FIELDS_QUERY, { name: datasetType });
	if (rowType.error || !rowType.data) return { dimension: null, candidates: [], error: rowType.error ?? "no row type returned" };

	const dimField = rowType.data.__type?.fields?.find((f) => f.name === "dimensions");
	const dimType = unwrap(dimField?.type);
	if (!dimType) return { dimension: null, candidates: [], error: "the dataset exposes no dimensions object" };

	const dims = await graphql<FieldsResponse>(token, TYPE_FIELDS_QUERY, { name: dimType });
	if (dims.error || !dims.data) return { dimension: null, candidates: [], error: dims.error ?? "no dimension type returned" };

	const names = (dims.data.__type?.fields ?? []).map((f) => f.name);
	return { dimension: findKeyExchangeDimension(names), candidates: tlsIsh(names) };
}

interface AdaptiveRow {
	count: number;
	dimensions?: Record<string, string>;
}

/**
 * Classify one key-exchange value.
 *
 * `NONE` means the request used no TLS and `UNK` means Cloudflare could not determine the group;
 * neither is evidence of a classical handshake, so both are counted apart rather than folded into
 * `classical` — which would understate adoption by blaming traffic that was never measured.
 */
function classify(group: string): "pqc" | "classical" | "indeterminate" {
	const value = group.trim().toUpperCase();
	if (!value || value === "UNK" || value === "NONE") return "indeterminate";
	// Hybrids name their post-quantum half: X25519MLKEM768 today, X25519Kyber768Draft00 before it.
	return value.includes("MLKEM") || value.includes("KYBER") ? "pqc" : "classical";
}

const adoptionQuery = (dimension: string, hostDimension: string) => `
query PqcAdoption($zoneTag: string!, $since: Time!, $until: Time!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: $limit
        orderBy: [count_DESC]
      ) {
        count
        dimensions { ${hostDimension} ${dimension} }
      }
    }
  }
}`;

/**
 * Real adoption per hostname over the window.
 *
 * Zone-scoped like every other zone dataset, so this fans out. A zone that fails is recorded and
 * skipped rather than failing the page: partial measurement is still measurement, as long as the
 * gap is stated.
 */
export async function fetchAdoption(
	token: string,
	zones: { id: string; name: string }[],
	window: { since: string; until: string },
	dimension: string,
	hostDimension = "clientRequestHTTPHost",
): Promise<AdoptionResult> {
	const byHost = new Map<string, HostAdoption>();
	const errors: { source: string; message: string }[] = [];

	for (const zone of zones) {
		const result = await graphql<{ viewer?: { zones?: { httpRequestsAdaptiveGroups?: AdaptiveRow[] }[] } }>(
			token,
			adoptionQuery(dimension, hostDimension),
			{ zoneTag: zone.id, since: window.since, until: window.until, limit: ROW_LIMIT },
		);
		if (result.error) {
			errors.push({ source: `zone ${zone.name} adoption`, message: result.error });
			continue;
		}

		for (const row of result.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? []) {
			const fqdn = (row.dimensions?.[hostDimension] ?? "").toLowerCase();
			if (!fqdn) continue;
			const entry = byHost.get(fqdn) ?? { fqdn, pqc: 0, classical: 0, indeterminate: 0 };
			entry[classify(row.dimensions?.[dimension] ?? "")] += row.count;
			byHost.set(fqdn, entry);
		}
	}

	const hosts = [...byHost.values()].sort((a, b) => b.pqc + b.classical - (a.pqc + a.classical));
	const totals = hosts.reduce(
		(acc, host) => ({
			pqc: acc.pqc + host.pqc,
			classical: acc.classical + host.classical,
			indeterminate: acc.indeterminate + host.indeterminate,
		}),
		{ pqc: 0, classical: 0, indeterminate: 0 },
	);

	return { available: true, dimension, candidatesSeen: [], reason: "", window, hosts, totals, errors };
}

/** The reason string shown when the schema cannot answer this. Names the alternative. */
export function unavailableReason(candidates: string[]): string {
	const seen = candidates.length ? ` The dataset does expose ${candidates.join(", ")}, none of which describes a key agreement.` : "";
	return (
		"This account's GraphQL schema exposes no key-exchange dimension on httpRequestsAdaptiveGroups, so measured adoption cannot be read here." +
		seen +
		" Cloudflare reports it as ClientTLSKeyExchangeGroup in the http_requests Logpush dataset, queryable through Log Explorer — which stores logs per zone and needs the Logs Read permission, so it is an infrastructure decision rather than a code change."
	);
}

export { classify as classifyKeyExchange, findKeyExchangeDimension };

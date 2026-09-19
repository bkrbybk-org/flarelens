/**
 * Reading a `cloudflared` connector's own Prometheus `/metrics` endpoint.
 *
 * Cloudflare's API never reports connector CPU/memory — that only exists on the `cloudflared`
 * process's own host. An operator who wants it published has to expose it themselves, typically
 * through another tunnel hostname behind Access. Because that hostname is operator infrastructure,
 * not something Cloudflare's API can enumerate, it is deploy-time configuration (a Worker secret),
 * never something a request can supply: a client asks for metrics "by tunnel id" only, and the
 * Worker looks up the target — a URL, host, or path from the client would make this Worker an
 * open relay to whatever it was pointed at.
 */

import { HEX_ID_PATTERN } from "../http";

export interface TunnelMetricsTarget {
	tunnelId: string;
	connectorId?: string;
	url: string;
}

export interface ParsedMetricsConfig {
	/** Valid targets, keyed by tunnel id (last one wins on a duplicate id — same as JSON object semantics). */
	byTunnelId: Map<string, TunnelMetricsTarget>;
	/** Entries that failed validation, so misconfiguration is visible rather than silently dropped. */
	invalid: { index: number; reason: string }[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Tunnel ids in the rest of this codebase are 32-char hex, same shape `validHexId` accepts. */
export function isValidTunnelId(value: string | undefined | null): boolean {
	return typeof value === "string" && (UUID_PATTERN.test(value) || HEX_ID_PATTERN.test(value));
}

/**
 * A target URL must point at a metrics endpoint the operator deliberately published, not
 * anything a client-controlled string could resolve to:
 *  - `https:` only (no plaintext, no `file:`/`data:` etc.)
 *  - no userinfo (`https://user:pass@host/...`) — credentials belong in the Access secrets, not
 *    embedded in a URL that might be logged
 *  - hostname must not be an IP literal or `localhost` — this must be a real published hostname
 *    (typically itself a Cloudflare Tunnel hostname), not a pointer into the Worker's own network
 *  - path must end with `/metrics`, so a misconfigured entry can't be pointed at an unrelated
 *    endpoint on the same host
 */
export function validateMetricsUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "not a valid URL" };
	}
	if (url.protocol !== "https:") return { ok: false, reason: "must use https:" };
	if (url.username || url.password) return { ok: false, reason: "must not contain credentials" };
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "127.0.0.1" || host === "::1") return { ok: false, reason: "must not target localhost" };
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return { ok: false, reason: "must not target an IP literal" };
	if (!url.pathname.endsWith("/metrics")) return { ok: false, reason: "path must end with /metrics" };
	return { ok: true, url };
}

/** Parses and validates the `TUNNEL_METRICS` secret. Never throws — an unparsable secret just means no targets. */
export function parseTunnelMetricsConfig(raw: string | undefined): ParsedMetricsConfig {
	const byTunnelId = new Map<string, TunnelMetricsTarget>();
	const invalid: { index: number; reason: string }[] = [];
	if (!raw) return { byTunnelId, invalid };

	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch {
		return { byTunnelId, invalid: [{ index: -1, reason: "TUNNEL_METRICS is not valid JSON" }] };
	}
	if (!Array.isArray(entries)) {
		return { byTunnelId, invalid: [{ index: -1, reason: "TUNNEL_METRICS must be a JSON array" }] };
	}

	entries.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") {
			invalid.push({ index, reason: "entry is not an object" });
			return;
		}
		const { tunnelId, connectorId, url } = entry as Record<string, unknown>;
		if (!isValidTunnelId(tunnelId as string)) {
			invalid.push({ index, reason: "tunnelId is not a valid id" });
			return;
		}
		if (connectorId !== undefined && !isUuid(connectorId)) {
			invalid.push({ index, reason: "connectorId is not a valid id" });
			return;
		}
		if (typeof url !== "string") {
			invalid.push({ index, reason: "url is missing" });
			return;
		}
		const validated = validateMetricsUrl(url);
		if (!validated.ok) {
			invalid.push({ index, reason: `url ${validated.reason}` });
			return;
		}
		byTunnelId.set((tunnelId as string).toLowerCase(), {
			tunnelId: tunnelId as string,
			connectorId: connectorId as string | undefined,
			url,
		});
	});

	return { byTunnelId, invalid };
}

// ---------------------------------------------------------------------------
// Prometheus text-format parsing — only the metric names this feature needs.

const WANTED_METRICS = new Set([
	"process_cpu_seconds_total",
	"process_resident_memory_bytes",
	"process_start_time_seconds",
	"cloudflared_tunnel_ha_connections",
	"cloudflared_tunnel_total_requests",
	"cloudflared_tunnel_request_errors",
	"cloudflared_tunnel_concurrent_requests_per_tunnel",
]);

export interface ParsedMetrics {
	processCpuSecondsTotal?: number;
	processResidentMemoryBytes?: number;
	processStartTimeSeconds?: number;
	haConnections?: number;
	totalRequests?: number;
	requestErrors?: number;
	concurrentRequests?: number;
}

const METRIC_KEY: Record<string, keyof ParsedMetrics> = {
	process_cpu_seconds_total: "processCpuSecondsTotal",
	process_resident_memory_bytes: "processResidentMemoryBytes",
	process_start_time_seconds: "processStartTimeSeconds",
	cloudflared_tunnel_ha_connections: "haConnections",
	cloudflared_tunnel_total_requests: "totalRequests",
	cloudflared_tunnel_request_errors: "requestErrors",
	cloudflared_tunnel_concurrent_requests_per_tunnel: "concurrentRequests",
};

/**
 * Strict, minimal Prometheus text-exposition-format parser: only the metric names above, summed
 * across label sets (several of these are counters exposed per-tunnel-id or per-status-code, and
 * this feature wants the connector-wide total). Anything else — HELP/TYPE lines, other metrics,
 * malformed lines — is ignored rather than making the whole read fail.
 */
export function parsePrometheusMetrics(text: string): ParsedMetrics {
	const totals = new Map<string, number>();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		// `metric_name{label="value",...} value [timestamp]` or `metric_name value`
		const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
		if (!match) continue;
		const [, name, , valueStr] = match;
		if (!WANTED_METRICS.has(name)) continue;
		const value = Number(valueStr);
		if (!Number.isFinite(value)) continue; // rejects "NaN", "+Inf", "-Inf" and garbage alike
		totals.set(name, (totals.get(name) ?? 0) + value);
	}
	const result: ParsedMetrics = {};
	for (const [name, value] of totals) {
		const key = METRIC_KEY[name];
		if (key) result[key] = value;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Secured fetch of a configured target.

export type MetricsFetchError =
	| { kind: "misconfigured"; reason: string }
	| { kind: "not-found" }
	| { kind: "forbidden" }
	| { kind: "access-denied" }
	| { kind: "timeout" }
	| { kind: "too-large" }
	| { kind: "not-metrics" }
	| { kind: "network"; reason: string };

export type MetricsFetchResult = { ok: true; metrics: ParsedMetrics; fetchedAt: string } | { ok: false; error: MetricsFetchError };

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Fetches and parses one target's `/metrics`. Never forwards the upstream response body or
 * headers to the caller of this function's caller — only the parsed numbers ever leave this
 * module. A redirect (Access commonly issues one to its login page on a bad/missing service
 * token) is treated as an error, not followed, since following it would leak the request to
 * wherever the redirect points and any "success" would actually be a login page, not metrics.
 */
export async function fetchTunnelMetrics(
	target: TunnelMetricsTarget,
	credentials: { clientId?: string; clientSecret?: string },
): Promise<MetricsFetchResult> {
	const validated = validateMetricsUrl(target.url);
	if (!validated.ok) {
		return { ok: false, error: { kind: "misconfigured", reason: validated.reason } };
	}

	const headers: Record<string, string> = { Accept: "text/plain" };
	if (credentials.clientId) headers["CF-Access-Client-Id"] = credentials.clientId;
	if (credentials.clientSecret) headers["CF-Access-Client-Secret"] = credentials.clientSecret;

	let response: Response;
	try {
		response = await fetch(validated.url.toString(), {
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") return { ok: false, error: { kind: "timeout" } };
		return { ok: false, error: { kind: "network", reason: err instanceof Error ? err.message : "fetch failed" } };
	}

	// `redirect: "manual"` in the Workers runtime surfaces a redirect as a normal 3xx response
	// rather than an opaqueredirect — treat any of them as the Access-login-page case.
	if (response.status >= 300 && response.status < 400) {
		return { ok: false, error: { kind: "access-denied" } };
	}
	if (response.status === 401 || response.status === 403) {
		return { ok: false, error: { kind: "access-denied" } };
	}
	if (response.status === 404) {
		return { ok: false, error: { kind: "not-found" } };
	}
	if (!response.ok) {
		return { ok: false, error: { kind: "network", reason: `HTTP ${response.status}` } };
	}

	const contentType = response.headers.get("Content-Type") || "";
	if (contentType && !contentType.includes("text/plain") && !contentType.includes("text/") && !contentType.includes("application/openmetrics")) {
		return { ok: false, error: { kind: "not-metrics" } };
	}

	// Cap the body before parsing: read via the stream so an oversize body is aborted rather than
	// buffered in full first.
	const reader = response.body?.getReader();
	if (!reader) {
		return { ok: false, error: { kind: "network", reason: "empty response body" } };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > MAX_BODY_BYTES) {
					await reader.cancel().catch(() => {});
					return { ok: false, error: { kind: "too-large" } };
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		return { ok: false, error: { kind: "network", reason: err instanceof Error ? err.message : "read failed" } };
	}

	const text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concatChunks(chunks, total));
	if (!/^[a-zA-Z_:#]/m.test(text) || !WANTED_METRICS_TEXT_HINT.test(text)) {
		return { ok: false, error: { kind: "not-metrics" } };
	}
	const metrics = parsePrometheusMetrics(text);
	return { ok: true, metrics, fetchedAt: new Date().toISOString() };
}

const WANTED_METRICS_TEXT_HINT = /process_|cloudflared_/;

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

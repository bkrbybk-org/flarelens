import type { ApiEnvelope, CfAccount, CfZone, ZeroTrustData } from "../types";

export class ApiError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * In server mode the worker holds the credential and Cloudflare Access authenticates the
 * operator, so the browser has no token to send. Omit the header entirely rather than sending
 * an empty or placeholder Bearer, which the worker would treat as a caller-supplied token.
 */
export function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
	const response = await fetch(path, {
		headers: authHeaders(token),
	});

	let data: ApiEnvelope<T>;
	try {
		data = await response.json();
	} catch {
		throw new ApiError("Invalid response from server", response.status);
	}

	if (!response.ok || !data.success) {
		throw new ApiError(data.errors?.[0]?.message || "Request failed", response.status);
	}
	return data.result as T;
}

export interface CachedResult<T> {
	result: T;
	/** ISO timestamp from `X-Flarelens-Cached-At`. Null on a live (MISS) response. */
	cachedAt: string | null;
}

/**
 * Same contract as `apiFetch`, but for the edge-cached GET routes: also reads back the
 * `X-Flarelens-Cache`/`X-Flarelens-Cached-At` response headers so the caller can tell a cached
 * read from a live one, and optionally sends `X-Flarelens-Fresh: 1` to bypass the cache.
 */
async function apiFetchCached<T>(path: string, token: string, fresh?: boolean): Promise<CachedResult<T>> {
	const response = await fetch(path, {
		headers: authHeaders(token, fresh ? { "X-Flarelens-Fresh": "1" } : undefined),
	});

	let data: ApiEnvelope<T>;
	try {
		data = await response.json();
	} catch {
		throw new ApiError("Invalid response from server", response.status);
	}

	if (!response.ok || !data.success) {
		throw new ApiError(data.errors?.[0]?.message || "Request failed", response.status);
	}
	const isHit = response.headers.get("X-Flarelens-Cache") === "HIT";
	const cachedAt = isHit ? response.headers.get("X-Flarelens-Cached-At") : null;
	return { result: data.result as T, cachedAt };
}

export function fetchAccounts(token: string): Promise<CfAccount[]> {
	return apiFetch<CfAccount[]>("/api/accounts", token);
}

export function fetchZeroTrustData(token: string, accountId: string): Promise<ZeroTrustData> {
	return apiFetch<ZeroTrustData>(`/api/data?account_id=${encodeURIComponent(accountId)}`, token);
}

export function fetchZones(token: string, accountId: string, opts?: { fresh?: boolean }): Promise<CachedResult<CfZone[]>> {
	return apiFetchCached<CfZone[]>(`/api/zones?account_id=${encodeURIComponent(accountId)}`, token, opts?.fresh);
}

interface WafEventsEnvelope<T, D> extends ApiEnvelope<T> {
	diagnostics?: D;
}

export async function fetchWafEvents<E, D>(
	token: string,
	accountId: string,
	zoneId: string,
	minutes: number,
): Promise<{ events: E[]; diagnostics?: D }> {
	const response = await fetch("/api/waf/events", {
		method: "POST",
		headers: authHeaders(token, { "Content-Type": "application/json" }),
		body: JSON.stringify({ accountId, zoneId: zoneId || undefined, minutes }),
	});
	let data: WafEventsEnvelope<E[], D>;
	try {
		data = await response.json();
	} catch {
		throw new ApiError("Invalid response from server", response.status);
	}
	if (!response.ok || !data.success) {
		throw new ApiError(data.errors?.[0]?.message || "Request failed", response.status);
	}
	return { events: data.result || [], diagnostics: data.diagnostics };
}

/**
 * AI Security for Apps: one POST returns every section for the window.
 *
 * Deliberately not split per panel — the worker builds all of them from a single fan-out across
 * zones, so four endpoints would mean four times the GraphQL work for the same screen.
 */
export async function fetchAiSecurity<T>(
	token: string,
	body: { accountId: string; zoneId?: string; range: string; detection?: string; compare?: boolean; sessionKey?: string },
): Promise<T> {
	const response = await fetch("/api/ai-security/analyze", {
		method: "POST",
		headers: authHeaders(token, { "Content-Type": "application/json" }),
		body: JSON.stringify(body),
	});
	let data: ApiEnvelope<T>;
	try {
		data = await response.json();
	} catch {
		throw new ApiError("Invalid response from server", response.status);
	}
	if (!response.ok || !data.success) {
		throw new ApiError(data.errors?.[0]?.message || "Request failed", response.status);
	}
	return data.result as T;
}

async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		headers: authHeaders(token, { "Content-Type": "application/json" }),
		body: JSON.stringify(body),
	});
	let data: ApiEnvelope<T>;
	try {
		data = await response.json();
	} catch {
		throw new ApiError("Invalid response from server", response.status);
	}
	if (!response.ok || !data.success) {
		throw new ApiError(data.errors?.[0]?.message || "Request failed", response.status);
	}
	return data.result as T;
}

export function fetchCacheAnalysis<T>(token: string, zoneId: string, rangeHours: number): Promise<T> {
	return postJson<T>("/api/cache/analyze", token, { zoneId, rangeHours });
}

export function fetchWafRulesets<M>(token: string, accountId: string, zoneId: string): Promise<M> {
	const params = new URLSearchParams({ account_id: accountId });
	if (zoneId) {
		params.set("zone_id", zoneId);
	} else {
		params.set("include_zones", "1");
	}
	return apiFetch<M>(`/api/waf/rulesets?${params.toString()}`, token);
}

export interface AppConfig {
	mode: "byot" | "server";
	accounts?: { id: string; name: string }[];
	accountsError?: string;
	/** Running Worker version and when it was deployed, for the sidebar footer. */
	version?: { id: string; tag?: string; timestamp?: string };
}

/**
 * Asks the worker which credential model this deployment uses. Called before anything else and
 * without a token — in server mode the Access cookie is the only credential involved.
 */
export function fetchConfig(): Promise<AppConfig> {
	return apiFetch<AppConfig>("/api/config", "");
}

/** Script names deployed on the account. Needs Workers Scripts: Read. */
export function fetchWorkerScripts(token: string, accountId: string): Promise<string[]> {
	return apiFetch<string[]>(`/api/workers/scripts?account_id=${encodeURIComponent(accountId)}`, token);
}

export function fetchWorkerMetrics<T>(
	token: string,
	body: { accountId: string; from: string; to: string; granularity: string },
): Promise<T> {
	return postJson<T>("/api/workers/metrics", token, body);
}

export function fetchAccessUsage<T>(
	token: string,
	body: { accountId: string; from: string; to: string; granularity: string },
): Promise<T> {
	return postJson<T>("/api/access/usage", token, body);
}

export function fetchWorkersAiUsage<T>(
	token: string,
	body: { accountId: string; from: string; to: string; granularity: string },
): Promise<T> {
	return postJson<T>("/api/workers-ai/usage", token, body);
}

export function fetchGatewayUsage<T>(
	token: string,
	body: { accountId: string; from: string; to: string; granularity: string },
): Promise<T> {
	return postJson<T>("/api/gateway/usage", token, body);
}

export function fetchAiGatewayUsage<T>(
	token: string,
	body: { accountId: string; from: string; to: string; granularity: string },
): Promise<T> {
	return postJson<T>("/api/ai-gateway/usage", token, body);
}

export function fetchTunnelMap<T>(token: string, accountId: string, opts?: { fresh?: boolean }): Promise<CachedResult<T>> {
	return apiFetchCached<T>(`/api/access/tunnels?account_id=${encodeURIComponent(accountId)}`, token, opts?.fresh);
}

export function fetchPqcReport<T>(token: string, accountId: string, opts?: { fresh?: boolean }): Promise<CachedResult<T>> {
	return apiFetchCached<T>(`/api/pqc/report?account_id=${encodeURIComponent(accountId)}`, token, opts?.fresh);
}

export function fetchZoneHealthReport<T>(token: string, accountId: string): Promise<T> {
	return apiFetch<T>(`/api/zone-health/report?account_id=${encodeURIComponent(accountId)}`, token);
}

export function traceRequest<T>(
	token: string,
	body: { accountId: string; rayId: string; zoneId?: string; minutes: number },
): Promise<T> {
	return postJson<T>("/api/request/trace", token, body);
}

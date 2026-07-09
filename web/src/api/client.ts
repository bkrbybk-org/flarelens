import type { ApiEnvelope, CfAccount, CfZone, ZeroTrustData } from "../types";

export class ApiError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "ApiError";
	}
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
	const response = await fetch(path, {
		headers: { Authorization: `Bearer ${token}` },
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

export function fetchAccounts(token: string): Promise<CfAccount[]> {
	return apiFetch<CfAccount[]>("/api/accounts", token);
}

export function fetchZeroTrustData(token: string, accountId: string): Promise<ZeroTrustData> {
	return apiFetch<ZeroTrustData>(`/api/data?account_id=${encodeURIComponent(accountId)}`, token);
}

export function fetchZones(token: string, accountId: string): Promise<CfZone[]> {
	return apiFetch<CfZone[]>(`/api/zones?account_id=${encodeURIComponent(accountId)}`, token);
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
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

export async function fetchCacheAnalysis<T>(token: string, zoneId: string, rangeHours: number): Promise<T> {
	const response = await fetch("/api/cache/analyze", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ zoneId, rangeHours }),
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

export function fetchWafRulesets<M>(token: string, accountId: string, zoneId: string): Promise<M> {
	const params = new URLSearchParams({ account_id: accountId });
	if (zoneId) {
		params.set("zone_id", zoneId);
	} else {
		params.set("include_zones", "1");
	}
	return apiFetch<M>(`/api/waf/rulesets?${params.toString()}`, token);
}

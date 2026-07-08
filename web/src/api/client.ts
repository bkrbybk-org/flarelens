import type { ApiEnvelope, CfAccount, ZeroTrustData } from "../types";

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

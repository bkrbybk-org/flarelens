/**
 * The Cloudflare REST plumbing every section shares: the base URL, a paginated list read, and
 * bounded fan-out. There used to be a copy of each in every module that needed one — five
 * identical `mapWithConcurrency`s and four list readers differing only in names.
 */

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

const PER_PAGE = 100;

interface CfListEnvelope<T> {
	success?: boolean;
	result?: T[];
	errors?: { message?: string; code?: number }[];
	result_info?: { total_pages?: number };
}

export interface RestListResult<T> {
	result: T[];
	/** Set when any page failed; `result` is then empty, never a partial read. */
	error?: string;
	/** Cloudflare's own error code, where it gave one — some callers tell refusals apart by it. */
	code?: number;
	status: number;
}

export function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Every page of a list endpoint, concatenated. `path` is relative to {@link CF_API_BASE}. */
export async function restList<T>(path: string, token: string): Promise<RestListResult<T>> {
	const all: T[] = [];
	const sep = path.includes("?") ? "&" : "?";
	for (let page = 1; ; page++) {
		const response = await fetch(`${CF_API_BASE}${path}${sep}per_page=${PER_PAGE}&page=${page}`, { headers: authHeaders(token) });
		let body: CfListEnvelope<T>;
		try {
			body = await response.json();
		} catch {
			return { result: [], error: "Cloudflare returned a non-JSON response", status: 502 };
		}
		if (!response.ok || !body.success) {
			return {
				result: [],
				error: body.errors?.[0]?.message || `HTTP ${response.status}`,
				code: body.errors?.[0]?.code,
				status: response.status,
			};
		}
		all.push(...(body.result || []));
		const totalPages = body.result_info?.total_pages ?? 1;
		if (page >= totalPages || (body.result || []).length === 0) return { result: all, status: 200 };
	}
}

export interface CfListResponse<T> {
	success: boolean;
	errors?: { code?: number; message: string }[];
	result?: T[];
	result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

/** One page of a Cloudflare list/read endpoint. Kept distinct from {@link restList} (whose error
 * shape is a single string) because several routes still branch on `data.success` themselves. */
export async function fetchCloudflare<T>(path: string, token: string): Promise<{ status: number; data: CfListResponse<T> }> {
	const response = await fetch(`${CF_API_BASE}${path}`, { headers: authHeaders(token) });

	const status = response.status;
	let data: CfListResponse<T>;
	try {
		data = await response.json();
	} catch {
		data = { success: false, errors: [{ message: "Failed to parse Cloudflare API response" }] };
	}
	return { status, data };
}

/** Fetch every page of a list endpoint and concatenate results, in {@link fetchCloudflare}'s
 * `{status, result, errors}` shape (distinct from {@link restList}'s `RestListResult`). */
export async function fetchCloudflareAll<T>(
	path: string,
	token: string,
): Promise<{ status: number; result: T[]; errors?: { message: string }[] }> {
	const sep = path.includes("?") ? "&" : "?";
	const all: T[] = [];
	let page = 1;

	while (true) {
		const { status, data } = await fetchCloudflare<T>(`${path}${sep}per_page=${PER_PAGE}&page=${page}`, token);
		if (status !== 200 || !data.success) {
			return { status, result: [], errors: data.errors };
		}
		all.push(...(data.result || []));

		const totalPages = data.result_info?.total_pages ?? 1;
		if (page >= totalPages || (data.result || []).length === 0) {
			return { status: 200, result: all };
		}
		page++;
	}
}

/** Run tasks with bounded concurrency; Workers allow ~6 simultaneous connections per host. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

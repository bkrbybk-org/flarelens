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

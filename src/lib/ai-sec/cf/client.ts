import { CfApiError, type AiSecEnv, type GraphQLError, type Zone } from './types';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';

function authHeaders(env: AiSecEnv): HeadersInit {
	if (!env.CF_API_TOKEN) {
		throw new CfApiError('CF_API_TOKEN is not set. Run: npx wrangler secret put CF_API_TOKEN', 500);
	}
	return {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		'Content-Type': 'application/json',
	};
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, init);
			// Retry only on transient upstream conditions.
			if (res.status === 429 || res.status >= 500) {
				lastErr = new CfApiError(`Cloudflare API returned ${res.status}`, res.status, await res.text());
				if (i < attempts - 1) {
					await new Promise((r) => setTimeout(r, 250 * 2 ** i));
					continue;
				}
				throw lastErr;
			}
			return res;
		} catch (err) {
			lastErr = err;
			if (i === attempts - 1) break;
			await new Promise((r) => setTimeout(r, 250 * 2 ** i));
		}
	}
	throw lastErr instanceof Error ? lastErr : new CfApiError('Cloudflare API request failed', 502, lastErr);
}

/**
 * Run a GraphQL document against the Cloudflare Analytics API.
 *
 * The document is always supplied by this Worker's own code — never by the client —
 * so an unauthenticated dashboard cannot turn the Worker into an open API proxy.
 */
export async function graphql<T>(env: AiSecEnv, query: string, variables: Record<string, unknown> = {}): Promise<T> {
	const res = await fetchWithRetry(GRAPHQL_ENDPOINT, {
		method: 'POST',
		headers: authHeaders(env),
		body: JSON.stringify({ query, variables }),
	});

	if (!res.ok) {
		throw new CfApiError(`GraphQL HTTP ${res.status}`, res.status, await res.text());
	}

	const body = (await res.json()) as { data?: T; errors?: GraphQLError[] };
	if (body.errors?.length) {
		const msg = body.errors.map((e) => e.message).join('; ');
		throw new CfApiError(`GraphQL error: ${msg}`, 400, body.errors);
	}
	if (!body.data) {
		throw new CfApiError('GraphQL response had no data', 502, body);
	}
	return body.data;
}

/** Same as graphql(), but resolves to null instead of throwing. Used for per-zone fan-out. */
export async function graphqlSafe<T>(
	env: AiSecEnv,
	query: string,
	variables: Record<string, unknown> = {},
): Promise<{ data: T | null; error: string | null }> {
	try {
		return { data: await graphql<T>(env, query, variables), error: null };
	} catch (err) {
		return { data: null, error: err instanceof Error ? err.message : String(err) };
	}
}

interface ZoneListResponse {
	success: boolean;
	result: { id: string; name: string }[];
	result_info?: { page: number; total_pages: number };
	errors?: { message: string }[];
}

/** List all zones in the account, following pagination. */
export async function listZones(env: AiSecEnv): Promise<Zone[]> {
	if (!env.CF_ACCOUNT_ID) {
		throw new CfApiError('CF_ACCOUNT_ID is not set. Set it in wrangler.jsonc vars or .dev.vars', 500);
	}

	const zones: Zone[] = [];
	let page = 1;
	let totalPages = 1;

	do {
		const url = `${REST_BASE}/zones?account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}&per_page=50&page=${page}`;
		const res = await fetchWithRetry(url, { headers: authHeaders(env) });
		if (!res.ok) {
			throw new CfApiError(`Zone list failed: HTTP ${res.status}`, res.status, await res.text());
		}
		const body = (await res.json()) as ZoneListResponse;
		if (!body.success) {
			throw new CfApiError(`Zone list failed: ${body.errors?.map((e) => e.message).join('; ') ?? 'unknown'}`, 502, body.errors);
		}
		zones.push(...body.result.map((z) => ({ id: z.id, name: z.name })));
		totalPages = body.result_info?.total_pages ?? 1;
		page++;
	} while (page <= totalPages);

	const allow = (env.ZONE_ALLOWLIST ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const filtered = allow.length ? zones.filter((z) => allow.includes(z.id) || allow.includes(z.name)) : zones;
	return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

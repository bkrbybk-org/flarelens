/**
 * Worker-internal edge cache for slow, slowly-changing read routes.
 *
 * Three routes (`/api/zones`, `/api/access/tunnels`, `/api/pqc/report`) each read configuration
 * that changes on the order of minutes, not seconds, but cost seconds of upstream fan-out per
 * request. `caches.default` (the Cloudflare Cache API, same mechanism `getSchemaCaps` in
 * ai-sec/cf/schema.ts already uses) lets a Worker isolate hold that response at the edge for a
 * short TTL without a KV or DO round trip.
 *
 * This is NOT the browser cache: every /api/* response still carries `Cache-Control: no-store`
 * from middleware, so the browser always revalidates. This cache sits only between the route
 * handler and the upstream Cloudflare API call.
 *
 * SECURITY: the cache key must be namespaced by the resolved credential (via `tokenFingerprint`)
 * and by auth mode. A key built from anything else — the raw request URL, a header, an unvalidated
 * query param — risks either a cross-tenant read (two BYOT callers sharing a key) or key-space
 * poisoning (an attacker appending junk query params to force cache misses or to park a payload
 * under a key a later legitimate request will read). `cacheKey` therefore takes only the resolved
 * fingerprint/mode plus the caller's own already-validated params, never the request itself.
 *
 * Call pattern for a route (see src/index.ts for the three call sites):
 *
 *   const auth = await resolveAuth(...);            // 1. authenticate
 *   if (!auth.ok) return ...;
 *   const accountId = validHexId(...);               // 2. validate input
 *   if (!accountId) return ...;
 *   const scope = assertAllowedScope(auth.auth, c.env, { accountId }); // 3. authorize scope
 *   if (scope) return ...;
 *                                                      // ONLY NOW may the cache be consulted.
 *   const fingerprint = await tokenFingerprint(auth.auth.token);
 *   const key = cacheKey({ fingerprint, mode: auth.auth.mode, path: "/api/zones", params: { account_id: accountId } });
 *   const fresh = c.req.header("X-Flarelens-Fresh") === "1";
 *   const { status, body, cachedAt, hit } = await withEdgeCache({
 *     key, ttlSeconds: CACHE_TTL_SECONDS, fresh, waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
 *     compute: async () => { ... same work the route always did ...; return { status, body }; },
 *   });
 *   const res = c.json(body, status as 200);
 *   res.headers.set("X-Flarelens-Cache", hit ? "HIT" : "MISS");
 *   if (hit && cachedAt) res.headers.set("X-Flarelens-Cached-At", cachedAt);
 *   return res;
 *
 * `/api/zone-health/report` (built in parallel, merging after this) is expected to adopt the same
 * pattern — keep this module's exports stable.
 */

export const CACHE_TTL_SECONDS = 60;

export type WaitUntil = (p: Promise<unknown>) => void;

export interface CacheKeyParams {
	fingerprint: string;
	mode: "byot" | "server";
	path: string;
	/** Only explicitly passed, already-validated params — never the raw request URL or headers. */
	params?: Record<string, string | undefined>;
}

/**
 * Deterministic synthetic key for `caches.default`.
 *
 * Sorted by param name so two requests differing only in query-string order collide correctly
 * (a cache benefit), while an unknown extra param on the real request never reaches here at all —
 * callers pass only the specific fields they validated, so junk query params cannot create or
 * poison a key.
 */
export function cacheKey({ fingerprint, mode, path, params = {} }: CacheKeyParams): string {
	const qs = Object.keys(params)
		.filter((k) => params[k] !== undefined)
		.sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] as string)}`)
		.join("&");
	const suffix = qs ? `?${qs}` : "";
	return `https://flarelens.internal/api-cache/v1/${mode}/${fingerprint}${path}${suffix}`;
}

export interface ComputeResult {
	status: number;
	body: unknown;
}

export interface EdgeCacheResult {
	status: number;
	body: unknown;
	/** ISO timestamp of when the cached entry was written. Null unless `hit` is true. */
	cachedAt: string | null;
	hit: boolean;
}

interface StoredEntry {
	body: unknown;
	cachedAt: string;
}

function isCacheableSuccess(result: ComputeResult): boolean {
	if (result.status !== 200) return false;
	const body = result.body as { success?: unknown } | null;
	return !!body && body.success === true;
}

/**
 * Read-through cache around one route's compute step.
 *
 * - `fresh: true` (the `X-Flarelens-Fresh: 1` bypass) skips the read AND still refreshes the
 *   entry on a successful compute, so a manual "Sync" both bypasses and repairs a stale cache.
 * - Only a 200 with `success === true` is stored — an error or 4xx/5xx body must never be served
 *   back to a later caller as if it were live data.
 * - Cache reads and writes are best-effort: `caches.default` throwing (it can, it's not a real
 *   guarantee) must never fail the request — it falls through to a live compute instead.
 */
export async function withEdgeCache({
	key,
	ttlSeconds,
	fresh,
	waitUntil,
	compute,
}: {
	key: string;
	ttlSeconds: number;
	fresh: boolean;
	waitUntil: WaitUntil;
	compute: () => Promise<ComputeResult>;
}): Promise<EdgeCacheResult> {
	// `caches` is a Workers global with no Node equivalent; test suites that never previously hit
	// a cached route may not stub it at all. Guard the lookup itself, not just the calls on it —
	// a bare reference to an undeclared global throws before any try/catch inside would run.
	const cache: { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> } | null =
		typeof caches !== "undefined" && caches?.default ? caches.default : null;

	if (!fresh && cache) {
		try {
			const hit = await cache.match(key);
			if (hit) {
				const stored = (await hit.json()) as StoredEntry;
				return { status: 200, body: stored.body, cachedAt: stored.cachedAt, hit: true };
			}
		} catch {
			// Cache unavailable or corrupt entry — fall through to a live compute below.
		}
	}

	const result = await compute();

	if (cache && isCacheableSuccess(result)) {
		const cachedAt = new Date().toISOString();
		const entry: StoredEntry = { body: result.body, cachedAt };
		try {
			waitUntil(
				cache
					.put(
						key,
						new Response(JSON.stringify(entry), {
							headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
						}),
					)
					.catch(() => {
						// Write failure must not surface to the caller — the response below is still live.
					}),
			);
		} catch {
			// cache.put threw synchronously rather than rejecting — same rule, swallow it.
		}
	}

	return { status: result.status, body: result.body, cachedAt: null, hit: false };
}

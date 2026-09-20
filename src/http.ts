/**
 * Route helpers shared by more than one module in src/routes/*.ts. Everything here used to be
 * private to src/index.ts; it moved out only because index.ts itself split into per-area route
 * modules that all need it.
 */
import type { CfAccount } from "./cf-types";
import type { Env } from "./env";

/** Zero Trust ids (accounts, zones, apps, …) are 32-char hex strings. */
export const HEX_ID_PATTERN = /^[a-f0-9]{32}$/i;

export function validHexId(value: string | undefined | null): string | null {
	const normalized = String(value || "").trim();
	return HEX_ID_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Stamp the two edge-cache response headers.
 *
 * `X-Flarelens-Cached-At` only appears on a HIT — its presence, not just its value, is how the
 * client tells "this is cached" from "this is live" apart, so it must never be sent on a MISS
 * even with a null-ish value.
 */
export function withCacheHeaders(res: Response, hit: boolean, cachedAt: string | null): Response {
	res.headers.set("X-Flarelens-Cache", hit ? "HIT" : "MISS");
	if (hit && cachedAt) res.headers.set("X-Flarelens-Cached-At", cachedAt);
	return res;
}

/**
 * `c.executionCtx` throws when Hono wasn't handed one (several route tests call `app.request`
 * with only two arguments, since those routes never previously needed it). The cache write is
 * still best-effort without it — the promise just runs unawaited instead of via waitUntil.
 */
export function edgeCacheWaitUntil(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): (p: Promise<unknown>) => void {
	return (p: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(p);
		} catch {
			void p;
		}
	};
}

/** Accounts on the deployment allowlist, mapped down to what the client actually needs. */
export function filterAllowedAccounts(accounts: CfAccount[], env: Env): { id: string; name: string }[] {
	const allowed = new Set(
		(env.ALLOWED_ACCOUNT_IDS || "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter(Boolean),
	);
	return accounts
		.filter((account) => allowed.has(account.id.toLowerCase()))
		.map((account) => ({ id: account.id, name: account.name || account.id }));
}

export const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
	"Content-Security-Policy": [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"font-src 'self'",
		"img-src 'self' data:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	].join("; "),
};

/**
 * Paths whose CSP relaxes `style-src` to include `'unsafe-inline'`.
 *
 * Swagger UI injects inline `<style>` tags it does not let us route around, so `/docs` alone
 * needs this. Kept as an explicit, small, documented list rather than a path prefix or pattern —
 * a new route must be added here deliberately, not swept in by matching `/docs*`. `script-src`
 * is never loosened for any path.
 */
export const CSP_UNSAFE_INLINE_STYLE_PATHS: readonly string[] = ["/docs"];

/** The response headers to stamp for a given request path — `SECURITY_HEADERS`, with the `/docs` CSP exception applied when the path is on the list above. */
export function securityHeadersFor(path: string): Record<string, string> {
	if (!CSP_UNSAFE_INLINE_STYLE_PATHS.includes(path)) {
		return SECURITY_HEADERS;
	}
	return {
		...SECURITY_HEADERS,
		"Content-Security-Policy": SECURITY_HEADERS["Content-Security-Policy"].replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
	};
}

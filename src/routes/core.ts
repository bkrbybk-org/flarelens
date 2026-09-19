import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflare, fetchCloudflareAll } from "../lib/cf-rest";
import type { CfAccount, CfZone } from "../cf-types";
import { edgeCacheWaitUntil, filterAllowedAccounts, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerCoreRoutes(app: App): void {
	app.get("/health", (c) => c.json({ status: "ok" }));

	/** Accounts the caller may use. In server mode the deployment allowlist narrows the list. */
	app.get("/api/accounts", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		const { status, data } = await fetchCloudflare<CfAccount>("/accounts", token);
		if (status !== 200 || !data.success || auth.auth.mode !== "server") {
			return c.json(data, status as 200);
		}
		// Offering an account the allowlist would refuse just produces a 403 one click later.
		return c.json({ ...data, result: filterAllowedAccounts(data.result || [], c.env) });
	});

	/**
	 * Bootstrap for the SPA: which credential model is in play, and which accounts are on offer.
	 *
	 * Deliberately returns `byot` rather than 401 when the Access gate does not pass, so an
	 * unauthenticated caller learns nothing about whether this deployment binds a token. The token
	 * itself is never part of the response — only the mode and the account list it can reach.
	 */
	app.get("/api/config", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		const version = c.env.CF_VERSION_METADATA
			? { id: c.env.CF_VERSION_METADATA.id, tag: c.env.CF_VERSION_METADATA.tag, timestamp: c.env.CF_VERSION_METADATA.timestamp }
			: undefined;

		if (!auth.ok || auth.auth.mode !== "server") {
			return c.json({ success: true, result: { mode: "byot", version } });
		}

		const { status, data } = await fetchCloudflare<CfAccount>("/accounts", auth.auth.token);
		if (status !== 200 || !data.success) {
			return c.json({
				success: true,
				result: { mode: "server", accounts: [], accountsError: "Failed to list accounts for the configured token", version },
			});
		}

		return c.json({
			success: true,
			result: { mode: "server", accounts: filterAllowedAccounts(data.result || [], c.env), version },
		});
	});

	app.get("/api/zones", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		const rawAccountId = c.req.query("account_id");
		if (!rawAccountId) {
			return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
		}
		// Interpolated into upstream paths below, so it must be an id and nothing else.
		const accountId = validHexId(rawAccountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		// Slowly-changing configuration (~0.5-1s upstream), so it is worth a short edge cache. Key is
		// namespaced by the resolved token's fingerprint and auth mode — never by the raw request URL.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({ fingerprint, mode: auth.auth.mode, path: "/api/zones", params: { account_id: accountId } });
		const fresh = c.req.header("X-Flarelens-Fresh") === "1";
		const { status, body, cachedAt, hit } = await withEdgeCache({
			key,
			ttlSeconds: CACHE_TTL_SECONDS,
			fresh,
			waitUntil: edgeCacheWaitUntil(c),
			compute: async () => {
				const res = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
				if (res.status !== 200) {
					return { status: res.status, body: { success: false, errors: res.errors || [{ message: "Failed to fetch zones" }] } };
				}
				return { status: 200, body: { success: true, result: res.result.map((z) => ({ id: z.id, name: z.name })) } };
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

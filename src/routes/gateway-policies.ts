// ---------------------------------------------------------------------------
// Gateway Policies (the account's Gateway rules, in enforcement order)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { buildGatewayPoliciesReport, type CfGatewayRule } from "../lib/gateway-policies";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerGatewayPoliciesRoutes(app: App): void {
	/**
	 * The account's Gateway rules, grouped by policy type and ordered the way Cloudflare enforces
	 * them — see src/lib/gateway-policies.ts for the model and its cited sources.
	 *
	 * Account-wide, same edge-cache pattern as Zone Health: short TTL, keyed on the caller's token
	 * fingerprint, bypassed by Sync via X-Flarelens-Fresh.
	 */
	app.get("/api/gateway/policies", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const accountId = validHexId(c.req.query("account_id"));
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		const token = auth.auth.token;

		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/gateway/policies",
			params: { account_id: accountId },
		});
		const fresh = c.req.header("X-Flarelens-Fresh") === "1";
		const { status, body, cachedAt, hit } = await withEdgeCache({
			key,
			ttlSeconds: CACHE_TTL_SECONDS,
			fresh,
			waitUntil: edgeCacheWaitUntil(c),
			compute: async () => {
				const rulesRes = await fetchCloudflareAll<CfGatewayRule>(`/accounts/${encodeURIComponent(accountId)}/gateway/rules`, token);
				if (rulesRes.status !== 200) {
					return { status: rulesRes.status, body: { success: false, errors: rulesRes.errors || [{ message: "Failed to fetch Gateway rules" }] } };
				}
				const result = buildGatewayPoliciesReport(rulesRes.result);
				return { status: 200, body: { success: true, result } };
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

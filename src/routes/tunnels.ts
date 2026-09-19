// ---------------------------------------------------------------------------
// Access application → Tunnel → origin mapping

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { TunnelMapError, fetchTunnelMap } from "../lib/access-tunnels";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfApp, CfPolicy } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import { policiesByApp } from "./access";
import type { App } from "../env";

export function registerTunnelRoutes(app: App): void {
	/**
	 * Joins Access applications to the tunnel ingress rules that serve their hostnames.
	 *
	 * Apps are fetched here rather than taken from the client so the join cannot be skewed by a
	 * stale page: the mapping is only meaningful if both halves come from the same moment.
	 */
	app.get("/api/access/tunnels", async (c) => {
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

		// Measured ~4.0s upstream (Access apps + policies + tunnel fan-out), so this is the primary
		// target for the edge cache. Key is namespaced by the resolved token's fingerprint and auth
		// mode — never by the raw request URL.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({ fingerprint, mode: auth.auth.mode, path: "/api/access/tunnels", params: { account_id: accountId } });
		const fresh = c.req.header("X-Flarelens-Fresh") === "1";
		const { status, body, cachedAt, hit } = await withEdgeCache({
			key,
			ttlSeconds: CACHE_TTL_SECONDS,
			fresh,
			waitUntil: edgeCacheWaitUntil(c),
			compute: async () => {
				const [appsRes, policiesRes] = await Promise.all([
					fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, token),
					fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/policies`, token),
				]);
				if (appsRes.status !== 200) {
					return {
						status: appsRes.status,
						body: { success: false, errors: appsRes.errors || [{ message: "Failed to fetch applications" }] },
					};
				}

				// Per-app policies, same bounded fan-out as /api/data. Reusable policies are resolved from
				// the account list so a policy attached by reference still shows its name and decision.
				const reusable = new Map((policiesRes.status === 200 ? policiesRes.result : []).map((p) => [p.id, p]));
				// Started before the policy resolution is awaited: the tunnel map needs the applications only
				// to join hostnames at the very end, so the two run side by side.
				const withPolicies = policiesByApp(appsRes.result, accountId, token).then((policyMap) =>
					appsRes.result.map((appItem) => {
						const entry = policyMap.get(appItem.id);
						const policies = (entry?.policies ?? []).map((p) => {
							const hasRules = Array.isArray(p.include) || Array.isArray(p.exclude) || Array.isArray(p.require);
							const source = !hasRules && reusable.has(p.id) ? { ...reusable.get(p.id), ...p } : p;
							return { name: source.name, decision: source.decision };
						});
						return { ...appItem, policies, policies_error: entry?.error ?? false };
					}),
				);

				try {
					const result = await fetchTunnelMap(accountId, token, withPolicies);
					return { status: 200, body: { success: true, result } };
				} catch (err) {
					const errStatus = err instanceof TunnelMapError ? err.status : 502;
					const message = err instanceof Error ? err.message : "Failed to build the tunnel map";
					return { status: errStatus, body: { success: false, errors: [{ message }] } };
				}
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

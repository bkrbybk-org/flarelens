// ---------------------------------------------------------------------------
// Access application → Tunnel → origin mapping

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { TunnelMapError, fetchTunnelMap } from "../lib/access-tunnels";
import type { TunnelMapResult } from "../lib/access-tunnels";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflare, fetchCloudflareAll } from "../lib/cf-rest";
import type { CfApp, CfPolicy } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import { policiesByApp } from "./access";
import type { App } from "../env";
import { getLatestCloudflaredCached, versionBehindNote } from "../lib/cloudflared-version";
import { fetchTunnelMetrics, isValidTunnelId, parseTunnelMetricsConfig } from "../lib/tunnel-metrics";
import type { MetricsFetchError } from "../lib/tunnel-metrics";

/** Human-readable reason for each metrics-fetch failure kind — never the raw upstream body/headers. */
function metricsErrorMessage(error: MetricsFetchError): string {
	switch (error.kind) {
		case "misconfigured":
			return `Misconfigured metrics target: ${error.reason}.`;
		case "not-found":
			return "The metrics endpoint returned 404 Not Found.";
		case "forbidden":
			return "The metrics endpoint refused the request.";
		case "access-denied":
			return "Cloudflare Access refused the request — check the service token secrets.";
		case "timeout":
			return "The metrics endpoint did not respond in time.";
		case "too-large":
			return "The metrics response was larger than expected.";
		case "not-metrics":
			return "The response did not look like a Prometheus metrics document.";
		case "network":
			return `Could not reach the metrics endpoint (${error.reason}).`;
	}
}

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
		const waitUntil = edgeCacheWaitUntil(c);

		// Fetched concurrently with the (cached) tunnel map, under its own 1-hour cache — a GitHub
		// release changes far less often than the 60s tunnel map TTL warrants re-checking.
		const latestPromise = getLatestCloudflaredCached(waitUntil);

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
			waitUntil,
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

		const latest = await latestPromise;
		const metricsConfig = parseTunnelMetricsConfig(c.env.TUNNEL_METRICS);
		const responseBody = body as { success: boolean; result?: TunnelMapResult };
		if (responseBody?.success && responseBody.result) {
			for (const tunnel of responseBody.result.tunnels) {
				// Dedupe by version so two connectors on the same stale version don't produce two notes.
				const seen = new Set<string>();
				for (const connector of tunnel.connectors) {
					if (seen.has(connector.version)) continue;
					seen.add(connector.version);
					const note = versionBehindNote(connector.version, latest);
					if (note) tunnel.health = [...tunnel.health, note];
				}
				tunnel.hasMetricsTarget = metricsConfig.byTunnelId.has(tunnel.id.toLowerCase());
			}
			responseBody.result.latestCloudflared = latest;
		}

		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});

	/**
	 * Connector CPU/memory/HA metrics, read from an operator-published `cloudflared` Prometheus
	 * endpoint — never from anything the client sends. The target comes only from the deploy-time
	 * `TUNNEL_METRICS` secret; the client supplies just the tunnel id, and the Worker looks up
	 * (or refuses) the target itself. Not edge-cached: this is an on-demand "Load metrics" action.
	 */
	app.get("/api/tunnels/:tunnelId/metrics", async (c) => {
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

		const tunnelId = c.req.param("tunnelId");
		if (!isValidTunnelId(tunnelId)) {
			return c.json({ success: false, errors: [{ message: "Invalid tunnelId" }] }, 400);
		}

		const config = parseTunnelMetricsConfig(c.env.TUNNEL_METRICS);
		const target = config.byTunnelId.get(tunnelId.toLowerCase());
		if (!target) {
			// No configured target: 404, no upstream fetch of any kind.
			return c.json({ success: false, errors: [{ message: "No metrics target is configured for this tunnel." }] }, 404);
		}

		// The tunnel must belong to the allowlisted account the caller authenticated for — checked
		// against Cloudflare directly (not trusted from TUNNEL_METRICS) before any metrics fetch.
		const token = auth.auth.token;
		const { status: tunnelStatus, data: tunnelData } = await fetchCloudflare<{ id: string }>(
			`/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
			token,
		);
		if (tunnelStatus !== 200 || !tunnelData.success || !tunnelData.result) {
			return c.json({ success: false, errors: [{ message: "Tunnel does not belong to this account." }] }, 403);
		}

		const result = await fetchTunnelMetrics(target, {
			clientId: c.env.METRICS_ACCESS_CLIENT_ID,
			clientSecret: c.env.METRICS_ACCESS_CLIENT_SECRET,
		});
		if (!result.ok) {
			return c.json({ success: false, errors: [{ message: metricsErrorMessage(result.error) }] }, 502);
		}
		return c.json({ success: true, result: { metrics: result.metrics, fetchedAt: result.fetchedAt } }, 200);
	});
}

// ---------------------------------------------------------------------------
// Rate Limits & Bots (rate-limit rule review + bot management settings)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { RatelimitBotError, fetchRatelimitBotReport, type BbZone } from "../lib/ratelimit-bot";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerBotsRoutes(app: App): void {
	/**
	 * Rate-limit rules (account entrypoint + every zone's entrypoint) and bot management settings,
	 * per zone. `zone_id` narrows to one zone; account-wide otherwise, same shape as WAF and Zone
	 * Health. Served through the same short edge cache; Sync bypasses it.
	 */
	app.get("/api/bots/report", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const accountId = validHexId(c.req.query("account_id"));
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
		}
		const zoneParam = c.req.query("zone_id");
		const zoneId = zoneParam ? validHexId(zoneParam) : null;
		if (zoneParam && !zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid zone_id" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, zoneId ? { accountId, zoneId } : { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		const token = auth.auth.token;

		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/bots/report",
			params: { account_id: accountId, zone_id: zoneId ?? undefined },
		});
		const fresh = c.req.header("X-Flarelens-Fresh") === "1";
		const { status, body, cachedAt, hit } = await withEdgeCache({
			key,
			ttlSeconds: CACHE_TTL_SECONDS,
			fresh,
			waitUntil: edgeCacheWaitUntil(c),
			compute: async () => {
				const zonesRes = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
				if (zonesRes.status !== 200) {
					return { status: zonesRes.status, body: { success: false, errors: zonesRes.errors || [{ message: "Failed to fetch zones" }] } };
				}

				const zones: BbZone[] = zonesRes.result
					.filter((z) => !zoneId || z.id === zoneId)
					.map((z) => ({ id: z.id, name: z.name || z.id }));

				try {
					const result = await fetchRatelimitBotReport(accountId, zones, token);
					return { status: 200, body: { success: true, result } };
				} catch (err) {
					const errStatus = err instanceof RatelimitBotError ? err.status : 502;
					const message = err instanceof Error ? err.message : "Failed to build the Rate Limits & Bots report";
					return { status: errStatus, body: { success: false, errors: [{ message }] } };
				}
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

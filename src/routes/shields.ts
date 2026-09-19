// ---------------------------------------------------------------------------
// Shields (Page Shield + API Shield posture)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { ShieldsError, fetchShieldsReport, type ShZone } from "../lib/shields";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerShieldsRoutes(app: App): void {
	/**
	 * Client & API protection posture for every zone in the account, or one zone when `zone_id`
	 * narrows it. Account-scoped by default, same rationale as Zone Health: the inventory
	 * question ("which scripts, which endpoints") is naturally account-wide, and `zone_id` is an
	 * operator narrowing rather than the route's natural unit.
	 */
	app.get("/api/shields/report", async (c) => {
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

		// Same edge cache as Zone Health, for the same reason: slow, multi-zone fan-out, read only
		// after auth, validation and scope have all passed.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/shields/report",
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

				const zones: ShZone[] = zonesRes.result
					.filter((z) => !zoneId || z.id === zoneId)
					.map((z) => ({ id: z.id, name: z.name || z.id }));

				try {
					const result = await fetchShieldsReport(zones, token);
					return { status: 200, body: { success: true, result } };
				} catch (err) {
					const errStatus = err instanceof ShieldsError ? err.status : 502;
					const message = err instanceof Error ? err.message : "Failed to build the Shields report";
					return { status: errStatus, body: { success: false, errors: [{ message }] } };
				}
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

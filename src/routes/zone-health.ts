// ---------------------------------------------------------------------------
// Zone Health (certificate expiry and DNS hygiene)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { ZoneHealthError, fetchZoneHealthReport, type ZhZone } from "../lib/zone-health";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerZoneHealthRoutes(app: App): void {
	/**
	 * Certificate expiry and DNS hygiene for every zone in the account.
	 *
	 * Zone-wide by design, same rationale as PQC readiness: `zone_id` narrows to one zone when an
	 * operator wants that, but the inventory question is naturally account-wide. Served through the
	 * same short edge cache as the PQC report; Sync bypasses it.
	 */
	app.get("/api/zone-health/report", async (c) => {
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

		// Same edge cache as the PQC report, for the same reason: slow, slowly-changing, and only read
		// after auth, validation and scope have all passed above.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/zone-health/report",
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

				const zones: ZhZone[] = zonesRes.result
					.filter((z) => !zoneId || z.id === zoneId)
					.map((z) => ({ id: z.id, name: z.name || z.id }));

				try {
					const result = await fetchZoneHealthReport(accountId, token, zones);
					return { status: 200, body: { success: true, result } };
				} catch (err) {
					const errStatus = err instanceof ZoneHealthError ? err.status : 502;
					const message = err instanceof Error ? err.message : "Failed to build the Zone Health report";
					return { status: errStatus, body: { success: false, errors: [{ message }] } };
				}
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

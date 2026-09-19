// ---------------------------------------------------------------------------
// DNS records (account-wide flat listing across every zone)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { buildDnsRecordsReport, type CfDnsRecordRaw, type DnsZone, type DnsZoneRaw } from "../lib/dns-records";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll, mapWithConcurrency } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

export function registerDnsRoutes(app: App): void {
	/**
	 * Every DNS record across the account's zones, flattened into one table.
	 *
	 * Modelled exactly on `/api/zone-health/report` above: same auth → validation → scope → cache
	 * pipeline. Zones are fetched concurrently with the same bounded `mapWithConcurrency` the other
	 * fan-out routes use, and a zone whose DNS read fails still appears in the result, carrying its
	 * error, rather than being silently dropped.
	 */
	app.get("/api/dns/records", async (c) => {
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

		// Same edge cache as Zone Health and PQC, for the same reason: slow, slowly-changing, and only
		// read after auth, validation and scope have all passed above.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/dns/records",
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

				const zones: DnsZone[] = zonesRes.result
					.filter((z) => !zoneId || z.id === zoneId)
					.map((z) => ({ id: z.id, name: z.name || z.id }));

				const zoneRaws: DnsZoneRaw[] = [];
				await mapWithConcurrency(zones, 5, async (zone) => {
					const res = await fetchCloudflareAll<CfDnsRecordRaw>(`/zones/${zone.id}/dns_records`, token);
					if (res.status !== 200) {
						zoneRaws.push({ zone, records: [], error: res.errors?.[0]?.message || `HTTP ${res.status}` });
						return;
					}
					zoneRaws.push({ zone, records: res.result });
				});
				// Keep result order stable regardless of which zone's fetch finishes first.
				zoneRaws.sort((a, b) => zones.findIndex((z) => z.id === a.zone.id) - zones.findIndex((z) => z.id === b.zone.id));

				const result = buildDnsRecordsReport(zoneRaws);
				return { status: 200, body: { success: true, result } };
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

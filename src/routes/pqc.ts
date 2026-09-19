// ---------------------------------------------------------------------------
// PQC readiness (post-quantum coverage per hostname)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { PqcError, fetchPqcReport, type PqcZone } from "../lib/pqc";
import { emptyAdoption, fetchAdoption, probeAdoptionDimension, unavailableReason } from "../lib/pqc-adoption";
import { tokenFingerprint } from "../lib/ai-sec";
import { CACHE_TTL_SECONDS, cacheKey, withEdgeCache } from "../lib/edge-cache";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { edgeCacheWaitUntil, validHexId, withCacheHeaders } from "../http";
import type { App } from "../env";

/**
 * Window for measured adoption: the last 24 hours.
 *
 * Fixed rather than driven by the shared range picker, because this section is a configuration
 * inventory and does not otherwise carry a time range. A day is long enough to average over a
 * traffic cycle and short enough to reflect a client population that is changing month by month.
 * Both bounds go through toISOString(), the same injection boundary every other route uses.
 */
function adoptionWindow(): { since: string; until: string } {
	const until = new Date();
	const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
	return { since: since.toISOString(), until: until.toISOString() };
}

export function registerPqcRoutes(app: App): void {
	/**
	 * Post-quantum readiness for every proxiable hostname in the account.
	 *
	 * Zone-wide by design: the settings that decide the answer (TLS 1.3, SSL mode) are zone settings,
	 * and the inventory question being asked is "which of our names are not covered", which cannot be
	 * answered one zone at a time. `zone_id` narrows it when an operator wants a single zone.
	 *
	 * Needs Zone: DNS: Read for the record inventory. Without it each zone comes back carrying its
	 * own error and no rows, rather than the page reporting an empty, clean-looking account.
	 */
	app.get("/api/pqc/report", async (c) => {
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

		// Measured ~4.3s upstream (zone settings + DNS inventory + adoption probe), the second target
		// for the edge cache. Key is namespaced by the resolved token's fingerprint and auth mode —
		// never by the raw request URL — and includes zone_id so a whole-account read and a
		// single-zone read never collide.
		const fingerprint = await tokenFingerprint(token);
		const key = cacheKey({
			fingerprint,
			mode: auth.auth.mode,
			path: "/api/pqc/report",
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
					return {
						status: zonesRes.status,
						body: { success: false, errors: zonesRes.errors || [{ message: "Failed to fetch zones" }] },
					};
				}

				const zones: PqcZone[] = zonesRes.result
					.filter((z) => !zoneId || z.id === zoneId)
					.map((z) => ({ id: z.id, name: z.name || z.id }));

				try {
					// Adoption is measured from the analytics schema and the report is built from REST
					// settings and DNS; neither needs the other, so they run together. Serially the probe
					// alone added a round trip to a response that already takes several.
					const [report, adoption] = await Promise.all([
						fetchPqcReport(accountId, token, zones),
						// Measured adoption is a capability question, not a given: the key-exchange dimension
						// may not exist in this account's schema at all. Probe, then either measure or say why
						// not — never report 0% for a question the schema cannot answer. See lib/pqc-adoption.ts.
						(async () => {
							const probe = await probeAdoptionDimension(token);
							if (!probe.dimension) {
								return emptyAdoption(probe.error ?? unavailableReason(probe.candidates), probe.candidates);
							}
							const measured = await fetchAdoption(token, zones, adoptionWindow(), probe.dimension);
							if (measured.errors.length === zones.length && zones.length > 0) {
								// Every zone failed: the dimension introspects but cannot actually be queried,
								// which is a different failure from it being absent and is worth saying so.
								return emptyAdoption(
									`The ${probe.dimension} dimension exists but no zone could be queried: ${measured.errors[0].message}`,
									probe.candidates,
								);
							}
							return measured;
						})(),
					]);

					return { status: 200, body: { success: true, result: { ...report, adoption } } };
				} catch (err) {
					const errStatus = err instanceof PqcError ? err.status : 502;
					const message = err instanceof Error ? err.message : "Failed to build the PQC report";
					return { status: errStatus, body: { success: false, errors: [{ message }] } };
				}
			},
		});
		return withCacheHeaders(c.json(body as never, status as 200), hit, cachedAt);
	});
}

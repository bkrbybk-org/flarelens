// ---------------------------------------------------------------------------
// Access usage (login telemetry for Access-protected apps)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { MAX_ACCESS_RANGE_MS, AccessUsageError, fetchAccessUsage, isAccessGranularity } from "../lib/access-usage";
import { parseInstant } from "../lib/workers-analytics";
import { fetchCloudflareAll } from "../lib/cf-rest";
import type { CfApp, CfIdp } from "../cf-types";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerAccessUsageRoutes(app: App): void {
	/**
	 * Login volume, success/failure split and top apps, identity providers and countries.
	 *
	 * Deliberately aggregate-only: the dataset can break logins down per user identity, and this
	 * endpoint does not ask for that. Everything here answers "is Access working and who is it
	 * serving" without the response becoming a per-person access log.
	 */
	app.post("/api/access/usage", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: { accountId?: string; from?: string; to?: string; granularity?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(body.accountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
		}
		// Same instant parser as the Workers section: both bounds land in a GraphQL document.
		const since = parseInstant(body.from);
		const until = parseInstant(body.to);
		if (!since || !until) {
			return c.json({ success: false, errors: [{ message: "from and to must be ISO-8601 UTC instants" }] }, 400);
		}
		if (Date.parse(until) <= Date.parse(since)) {
			return c.json({ success: false, errors: [{ message: "to must be later than from" }] }, 400);
		}
		if (Date.parse(until) - Date.parse(since) > MAX_ACCESS_RANGE_MS) {
			// Cloudflare refuses anything wider than 1w on this dataset.
			return c.json({ success: false, errors: [{ message: "Access usage supports a range of at most 7 days" }] }, 400);
		}
		const granularity = isAccessGranularity(body.granularity) ? body.granularity : "hourly";
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			// Names are best-effort enrichment: a token without the Access read scopes still gets
			// the usage numbers, just labelled by uuid.
			const [appsRes, idpsRes] = await Promise.all([
				fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, auth.auth.token),
				fetchCloudflareAll<CfIdp>(`/accounts/${accountId}/access/identity_providers`, auth.auth.token),
			]);
			const appNames = Object.fromEntries(
				(appsRes.status === 200 ? appsRes.result : []).map((a) => [a.id, a.name || a.id]),
			);
			const idpNames = Object.fromEntries(
				(idpsRes.status === 200 ? idpsRes.result : []).map((i) => [i.id, i.name || i.id]),
			);

			const result = await fetchAccessUsage(accountId, auth.auth.token, {
				since,
				until,
				granularity,
				appNames,
				idpNames,
			});
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof AccessUsageError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to load Access usage";
			return c.json({ success: false, errors: [{ message }] }, status as 502);
		}
	});
}

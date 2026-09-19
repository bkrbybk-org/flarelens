// ---------------------------------------------------------------------------
// Workers analytics (per-script requests, errors, subrequests, CPU time)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import {
	MAX_RANGE_MS,
	WorkersAnalyticsError,
	fetchWorkerMetrics,
	isGranularity,
	listWorkerScripts,
	parseInstant,
} from "../lib/workers-analytics";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerWorkersRoutes(app: App): void {
	/** Script names on the account, for the Workers section's per-worker filter. */
	app.get("/api/workers/scripts", async (c) => {
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

		try {
			return c.json({ success: true, result: await listWorkerScripts(accountId, auth.auth.token) });
		} catch (err) {
			const status = err instanceof WorkersAnalyticsError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to list Workers scripts";
			return c.json({ success: false, errors: [{ message }] }, status as 502);
		}
	});

	/**
	 * Per-script invocation metrics for a window.
	 *
	 * Both bounds are required and must be full UTC instants: they are interpolated into a GraphQL
	 * document, so the parse is the boundary that keeps caller text out of the query.
	 */
	app.post("/api/workers/metrics", async (c) => {
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
		const since = parseInstant(body.from);
		const until = parseInstant(body.to);
		if (!since || !until) {
			return c.json({ success: false, errors: [{ message: "from and to must be ISO-8601 UTC instants" }] }, 400);
		}
		if (Date.parse(until) <= Date.parse(since)) {
			return c.json({ success: false, errors: [{ message: "to must be later than from" }] }, 400);
		}
		if (Date.parse(until) - Date.parse(since) > MAX_RANGE_MS) {
			return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
		}
		const granularity = isGranularity(body.granularity) ? body.granularity : "hourly";
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await fetchWorkerMetrics(accountId, auth.auth.token, { since, until, granularity });
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof WorkersAnalyticsError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to load Workers metrics";
			return c.json({ success: false, errors: [{ message }] }, status as 502);
		}
	});
}

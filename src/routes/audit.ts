// ---------------------------------------------------------------------------
// Account audit log

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { AuditLogError, MAX_AUDIT_RANGE_MS, fetchAuditLog } from "../lib/audit-log";
import { parseInstant } from "../lib/workers-analytics";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerAuditRoutes(app: App): void {
	/**
	 * Configuration changes in a window, newest first. Not edge-cached: this is activity, and the
	 * point of reading it is to see what just happened. See src/lib/audit-log.ts for what each
	 * event carries and what is withheld (actor IPs, request and response bodies).
	 */
	app.post("/api/audit/logs", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: { accountId?: string; from?: string; to?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(body.accountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
		}
		// Re-emitted through toISOString, so no caller text reaches the upstream query string.
		const since = parseInstant(body.from);
		const until = parseInstant(body.to);
		if (!since || !until) {
			return c.json({ success: false, errors: [{ message: "from and to must be ISO-8601 UTC instants" }] }, 400);
		}
		if (Date.parse(until) <= Date.parse(since)) {
			return c.json({ success: false, errors: [{ message: "to must be later than from" }] }, 400);
		}
		if (Date.parse(until) - Date.parse(since) > MAX_AUDIT_RANGE_MS) {
			return c.json({ success: false, errors: [{ message: "The audit log supports a range of at most 30 days" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await fetchAuditLog(accountId, auth.auth.token, since, until);
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof AuditLogError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to read the audit log";
			return c.json({ success: false, errors: [{ message }] }, status as 502);
		}
	});
}

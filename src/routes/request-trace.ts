// ---------------------------------------------------------------------------
// Per-request forensics by Ray ID

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { RequestTraceError, normaliseRayId, traceRequest } from "../lib/request-trace";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerRequestTraceRoutes(app: App): void {
	app.post("/api/request/trace", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: { accountId?: string; rayId?: string; zoneId?: string; minutes?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(body.accountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
		}
		const rayId = normaliseRayId(body.rayId);
		if (!rayId) {
			return c.json({ success: false, errors: [{ message: "Ray ID must be 16 hexadecimal characters" }] }, 400);
		}
		const zoneId = body.zoneId ? validHexId(body.zoneId) : null;
		if (body.zoneId && !zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid zoneId" }] }, 400);
		}
		// Cloudflare keeps this data for a bounded period; 30 days is the widest any section offers.
		const requested = Number(body.minutes);
		const minutes = Math.min(43_200, Math.max(30, Number.isFinite(requested) ? requested : 1440));
		const scope = assertAllowedScope(auth.auth, c.env, { accountId, zoneId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await traceRequest(
				auth.auth.token,
				{ accountId, rayId, zoneId: zoneId || undefined, minutes },
				(p) => c.executionCtx.waitUntil(p),
			);
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof RequestTraceError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to trace the request";
			return c.json({ success: false, errors: [{ message }] }, status === 401 || status === 403 ? status : (status as 502));
		}
	});
}

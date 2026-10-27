// ---------------------------------------------------------------------------
// Per-request forensics by Ray ID

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { RequestTraceError, normaliseRayId, traceRequest } from "../lib/request-trace";
import { requestContext } from "../lib/request-context";
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

	// The traced request's surroundings: what a drafted change would affect, where else the
	// deciding rule fired, and the client's requests either side.
	app.post("/api/request/context", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(String(body.accountId ?? ""));
		const zoneId = validHexId(String(body.zoneId ?? ""));
		if (!accountId || !zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId or zoneId" }] }, 400);
		}
		const ruleId = body.ruleId === undefined || body.ruleId === "" ? undefined : validHexId(String(body.ruleId));
		if (ruleId === null) {
			return c.json({ success: false, errors: [{ message: "Invalid ruleId" }] }, 400);
		}
		const text = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
		const clientIP = text(body.clientIP, 45);
		if (clientIP && !IP_PATTERN.test(clientIP)) {
			return c.json({ success: false, errors: [{ message: "Invalid clientIP" }] }, 400);
		}
		const around = text(body.around, 40);
		if (around && Number.isNaN(Date.parse(around))) {
			return c.json({ success: false, errors: [{ message: "Invalid around" }] }, 400);
		}
		const requested = Number(body.minutes);
		const minutes = Math.min(43_200, Math.max(60, Number.isFinite(requested) ? requested : 10_080));
		const scope = assertAllowedScope(auth.auth, c.env, { accountId, zoneId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		const until = new Date();
		until.setSeconds(0, 0);
		const since = new Date(until.getTime() - minutes * 60_000);
		const result = await requestContext(auth.auth.token, {
			zoneId,
			since: since.toISOString(),
			until: until.toISOString(),
			around,
			ruleId,
			clientIP,
			host: text(body.host, 255),
			path: text(body.path, 2048),
			impactIncludesIp: body.impactIncludesIp === true,
		});
		return c.json({ success: true, result });
	});
}

/** IPv4 or IPv6 literal — loose, the dataset is the real judge, but nothing else gets through. */
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

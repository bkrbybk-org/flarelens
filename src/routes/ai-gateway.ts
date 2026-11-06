// ---------------------------------------------------------------------------
// AI Gateway (request volume, tokens, spend, errors, cache, latency — field names resolved from
// the live schema, see src/lib/ai-gateway.ts), optionally drilled into one gateway/provider/model

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { MAX_AI_GATEWAY_RANGE_MS, AiGatewayUsageError, fetchAiGatewayUsage, isAiGatewayGranularity, type AiGatewayFilter } from "../lib/ai-gateway";
import { fetchAiGatewayConfig, fetchAiGatewayFlags, fetchAiGatewayRefusals, type AiGatewayFlagsResult, type AiGatewayRefusalsResult } from "../lib/ai-gateway-config";
import { parseInstant } from "../lib/workers-analytics";
import { validHexId } from "../http";
import type { App } from "../env";

/**
 * The slice to drill into: exact names from the page's own breakdowns. Anything that is not a short
 * string is refused, not ignored: a report that quietly covered more than was asked would mislead.
 */
function readFilter(raw: Record<string, unknown> | undefined): { filter: AiGatewayFilter } | { error: string } {
	const filter: AiGatewayFilter = {};
	for (const key of ["gateway", "provider", "model", "user"] as const) {
		const value = raw?.[key];
		if (value === undefined || value === null || value === "") continue;
		// A user is a `user` tag value — an email address, at most 320 characters — with no control characters.
		if (typeof value !== "string" || value.length > (key === "user" ? 320 : 256) || (key === "user" && /[\u0000-\u001f\u007f]/.test(value))) {
			return { error: `Invalid filter.${key}` };
		}
		filter[key] = value;
	}
	return { filter };
}

export function registerAiGatewayRoutes(app: App): void {
	app.post("/api/ai-gateway/usage", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: { accountId?: string; from?: string; to?: string; granularity?: string; filter?: Record<string, unknown>; tag?: unknown };
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
		if (Date.parse(until) - Date.parse(since) > MAX_AI_GATEWAY_RANGE_MS) {
			return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
		}
		const granularity = isAiGatewayGranularity(body.granularity) ? body.granularity : "hourly";
		// Sent upstream as GraphQL variables.
		const read = readFilter(body.filter);
		if ("error" in read) {
			return c.json({ success: false, errors: [{ message: read.error }] }, 400);
		}
		const { filter } = read;
		// A metadata tag key to break spend down by (a cost center, a team). Sent upstream as a
		// variable; anything but a short plain key is refused.
		let tag: string | undefined;
		if (body.tag !== undefined && body.tag !== null && body.tag !== "") {
			if (typeof body.tag !== "string" || !/^[\w.:-]{1,64}$/.test(body.tag)) {
				return c.json({ success: false, errors: [{ message: "Invalid tag" }] }, 400);
			}
			tag = body.tag;
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await fetchAiGatewayUsage(accountId, auth.auth.token, { since, until, granularity, filter, tag });
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof AiGatewayUsageError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to load AI Gateway usage";
			return c.json({ success: false, errors: [{ message }] }, status === 400 ? 400 : (status as 502));
		}
	});

	// Gateway settings and dynamic routes (REST, needs AI Gateway: Read). A missing permission is
	// said in the result, not as an error status, so the page can say what to add.
	app.post("/api/ai-gateway/config", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		let body: { accountId?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(body.accountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}
		try {
			return c.json({ success: true, result: await fetchAiGatewayConfig(accountId, auth.auth.token) });
		} catch (err) {
			return c.json({ success: false, errors: [{ message: err instanceof Error ? err.message : "Failed to read AI Gateway settings" }] }, 502);
		}
	});

	// The window's failed and refused requests, with why, and what was flagged but let through, from
	// the Logs API, for the page's slice. Each log is reduced to named fields in the Worker: prompts,
	// answers and caller metadata never leave it.
	const logRoute = (path: string, read: (accountId: string, token: string, since: string, until: string, slice: AiGatewayFilter) => Promise<AiGatewayRefusalsResult | AiGatewayFlagsResult>) =>
		app.post(path, async (c) => {
			const auth = await resolveAuth(c.req.raw, c.env);
			if (!auth.ok) {
				return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
			}
			let body: { accountId?: string; from?: string; to?: string; filter?: Record<string, unknown> };
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
			if (Date.parse(until) <= Date.parse(since) || Date.parse(until) - Date.parse(since) > MAX_AI_GATEWAY_RANGE_MS) {
				return c.json({ success: false, errors: [{ message: "to must be later than from, and at most 30 days after it" }] }, 400);
			}
			const slice = readFilter(body.filter);
			if ("error" in slice) {
				return c.json({ success: false, errors: [{ message: slice.error }] }, 400);
			}
			const scope = assertAllowedScope(auth.auth, c.env, { accountId });
			if (scope) {
				return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
			}
			try {
				return c.json({ success: true, result: await read(accountId, auth.auth.token, since, until, slice.filter) });
			} catch (err) {
				return c.json({ success: false, errors: [{ message: err instanceof Error ? err.message : "Failed to read AI Gateway logs" }] }, 502);
			}
		});
	logRoute("/api/ai-gateway/refusals", fetchAiGatewayRefusals);
	logRoute("/api/ai-gateway/flags", fetchAiGatewayFlags);
}

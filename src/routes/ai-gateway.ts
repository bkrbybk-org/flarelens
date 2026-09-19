// ---------------------------------------------------------------------------
// AI Gateway (request volume, tokens, spend, errors, cache — see src/lib/ai-gateway.ts for the
// unverified-field-name caveat: this has never been run against a real account)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { MAX_AI_GATEWAY_RANGE_MS, AiGatewayUsageError, fetchAiGatewayUsage, isAiGatewayGranularity } from "../lib/ai-gateway";
import { parseInstant } from "../lib/workers-analytics";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerAiGatewayRoutes(app: App): void {
	app.post("/api/ai-gateway/usage", async (c) => {
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
		if (Date.parse(until) - Date.parse(since) > MAX_AI_GATEWAY_RANGE_MS) {
			return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
		}
		const granularity = isAiGatewayGranularity(body.granularity) ? body.granularity : "hourly";
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await fetchAiGatewayUsage(accountId, auth.auth.token, { since, until, granularity });
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof AiGatewayUsageError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to load AI Gateway usage";
			return c.json({ success: false, errors: [{ message }] }, status as 502);
		}
	});
}

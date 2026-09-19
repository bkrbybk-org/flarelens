import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { loadAiSecurity, type AiSecRequest } from "../lib/ai-sec";
import { CfApiError } from "../lib/ai-sec/cf/types";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerAiSecurityRoutes(app: App): void {
	/**
	 * AI Security for Apps: KPIs, detection breakdowns and flagged requests for a window.
	 *
	 * One endpoint rather than several, because the ported aggregation builds every section from a
	 * single fan-out across zones — splitting it would re-run the same GraphQL queries per section.
	 * The response is the whole Dashboard object; the client picks what each panel needs.
	 *
	 * Errors from the ported layer are surfaced with their own status where they carry one (a 403
	 * from a token missing Analytics scope is not a 500 and should not read like one).
	 */
	app.post("/api/ai-security/analyze", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env, { allowServerMode: c.env.AI_REQUIRES_BYOT === "0" });
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		let body: AiSecRequest & { accountId?: string; zoneId?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const accountId = validHexId(body.accountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
		}
		const zoneId = body.zoneId ? validHexId(body.zoneId) : null;
		if (body.zoneId && !zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid zoneId" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId, zoneId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		try {
			const result = await loadAiSecurity(
				token,
				{ ...body, accountId, zoneId: zoneId || undefined },
				(p) => c.executionCtx.waitUntil(p),
			);
			return c.json({ success: true, result });
		} catch (err) {
			const status = err instanceof CfApiError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Failed to load AI Security telemetry";
			// 401/403 must reach the client intact: useAiSecurityData treats them as an expired
			// session and disconnects, which a blanket 502 would turn into a stuck error banner.
			return c.json({ success: false, errors: [{ message }] }, status === 401 || status === 403 ? status : 502);
		}
	});
}

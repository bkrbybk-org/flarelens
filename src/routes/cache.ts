// ---------------------------------------------------------------------------
// Cache rules analysis (ported from cf-cache-analyzer)

import { resolveAuth, assertAllowedScope } from "../lib/auth";
import {
	ALLOWED_RANGES,
	assembleAnalytics,
	computeInsights,
	fetchRuleShells,
	fetchVersioning,
	fetchZoneName,
	type CacheCredentials,
} from "../lib/cache-analysis";
import { validHexId } from "../http";
import type { App } from "../env";

export function registerCacheRoutes(app: App): void {
	app.post("/api/cache/analyze", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		let body: { zoneId?: string; rangeHours?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
		}
		const zoneId = validHexId(body.zoneId);
		if (!zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid zoneId" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { zoneId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}
		const requestedRange = Number(body.rangeHours);
		const rangeHours = ALLOWED_RANGES.includes(requestedRange) ? requestedRange : 24;
		const creds: CacheCredentials = { token, zoneId };

		const zoneStep = await fetchZoneName(creds);
		if ("error" in zoneStep) {
			return c.json({ success: false, errors: [{ message: zoneStep.error }] }, zoneStep.status);
		}

		const [rulesStep, versioning] = await Promise.all([
			fetchRuleShells(creds),
			fetchVersioning(creds, zoneStep.zoneName),
		]);
		if ("error" in rulesStep) {
			return c.json({ success: false, errors: [{ message: rulesStep.error }] }, rulesStep.status);
		}

		const bundle = await assembleAnalytics(rulesStep.rules, creds, rangeHours);
		const { insights, health } = computeInsights(bundle.rules, bundle.analyticsSource, bundle.unattributed);

		return c.json({
			success: true,
			result: {
				zoneName: zoneStep.zoneName,
				zoneId,
				rangeHours,
				insights,
				health,
				versioning,
				...bundle,
			},
		});
	});
}

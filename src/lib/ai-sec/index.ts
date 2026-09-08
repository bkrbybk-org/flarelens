/**
 * AI Security for Apps — server side.
 *
 * Ported from the standalone cf-ai-sec-dashboard, which was a server-rendered Hono app with one
 * Cloudflare token held in a Worker secret. Flarelens is a SPA whose worker proxies each
 * request using the token the operator connected with, so this module is the seam between the
 * two: it builds a per-request `Env` from a Bearer token and hands it to the ported data layer
 * unchanged.
 *
 * The GraphQL documents, schema probing and aggregation in ./cf and ./domain are the original
 * code and are deliberately untouched apart from cache keying — they are the part that took the
 * measurements to get right (which `firewallForAi*` fields exist on which dataset, and which
 * filter operators the aggregate datasets actually accept).
 */

import { listZones } from "./cf/client";
import { getSchemaCaps, type SchemaCaps } from "./cf/schema";
import { fetchAllZones } from "./cf/queries";
// Named AiSecEnv at the source, not aliased here: Flarelens already has a global `Env` (the
// worker's bindings) and src/index.ts has another, so a third interface called Env is a trap
// for whoever reads this next.
import type { AiSecEnv, Zone } from "./cf/types";
import { buildDashboard } from "./domain/transform";
// Pulled into tsconfig.worker.json's include the same way web/src/lib/expr.ts already is.
import type { AiSecResult } from "../../../web/src/lib/ai-sec/types";
import { buildWindow, DEFAULT_ENDPOINT_KEY, DEFAULT_RANGE, DEFAULT_SESSION_KEY, RANGES, type DashboardParams, type DetectionType, type EndpointKey, type RangeKey, type SessionKey, type TimeWindow } from "./domain/params";

/**
 * Custom topics need the `..._lt` filter operator on the ScoresMin scalar, which is
 * capability-gated. Resolving the field name is not enough: the KPI is fed by an aggregate
 * alias that only exists when the Groups dataset accepts that operator, so gating on the name
 * alone shows a hard 0 where the name resolves but the aggregate filter does not.
 *
 * Lived in the original app's worker entry point; it belongs with the loader that uses it.
 */
function hasCustomTopicAggregate(schema: SchemaCaps): boolean {
	const field = schema.ai.customTopicScoresMin;
	if (!field) return false;
	return !!schema.datasets.httpRequestsAdaptiveGroups?.filters.includes(`${field}_lt`);
}

/**
 * True when the row dataset actually resolved `ja4`. An older account, or a schema without the
 * field, must not let the "group by JA4" option produce a table grouped entirely on null keys.
 */
function hasJa4Field(schema: SchemaCaps): boolean {
	const ds = schema.ai.dataset ? schema.datasets[schema.ai.dataset] : undefined;
	return !!ds?.fields.includes("ja4");
}

export type WaitUntil = (p: Promise<unknown>) => void;

/**
 * Short, stable fingerprint of a token.
 *
 * Every cache key this feature writes is namespaced by it — see the note on Env.CF_TOKEN_FP.
 * Truncated to 16 hex characters: enough that two tokens will not collide in practice, short
 * enough to keep cache keys readable, and one-way either way.
 */
export async function tokenFingerprint(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface AiSecRequest {
	accountId: string;
	/** Empty means every zone the token can see — the "Account (all zones)" scope. */
	zoneId?: string;
	/** A key of RANGES. Unknown values fall back to the 24h default rather than erroring. */
	range?: string;
	detection?: DetectionType;
	compare?: boolean;
	sessionKey?: SessionKey;
	endpointKey?: EndpointKey;
}

const DETECTIONS = new Set<DetectionType>(["all", "injection", "pii", "unsafe", "custom"]);

/** params.ts keeps its own range guard private, so this is the local equivalent. */
function isRangeKey(value: string | undefined): value is RangeKey {
	return !!value && value in RANGES;
}

/**
 * Build the params object the ported aggregation expects.
 *
 * The original parsed these from a URL, because its state lived in the query string of a
 * server-rendered page. Flarelens keeps view state in the hash and posts a JSON body, so the
 * parsing is here instead — but the validation is the same shape: unknown values fall back to
 * a default rather than 400ing, since these arrive from a UI that can only produce valid ones
 * and a stale deep link should degrade to a working page.
 */
function toParams(body: AiSecRequest, zones: Zone[]): DashboardParams {
	const range: TimeWindow = buildWindow(isRangeKey(body.range) ? body.range : DEFAULT_RANGE, new Date());
	const detection = body.detection && DETECTIONS.has(body.detection) ? body.detection : "all";
	const zoneId = body.zoneId && zones.some((z) => z.id === body.zoneId) ? body.zoneId : null;
	return {
		range,
		zoneId,
		detection,
		compare: !!body.compare,
		refresh: 0,
		sessionKey: body.sessionKey ?? DEFAULT_SESSION_KEY,
		endpointKey: body.endpointKey ?? DEFAULT_ENDPOINT_KEY,
		limit: 500,
		narrow: {},
		cacheKey: "",
	} as DashboardParams;
}

/*
 * The response type is the shared wire contract, not this module's own shape.
 *
 * Declaring it here and letting the client redeclare its own copy is how Flarelens's other
 * features do it, and it works for an eight-field event. Dashboard is thirty-odd fields across
 * a dozen nested rows, so instead loadAiSecurity() is annotated with the type the browser
 * actually compiles against: drop a field the UI reads and this file stops compiling, rather
 * than the client rendering undefined at runtime.
 */
export type { AiSecResult };

/**
 * Turn the probe into something an operator can read.
 *
 * getSchemaCaps already computes all of this to decide which GraphQL aliases it can emit; until
 * now none of it reached the browser, so a KPI that is zero because the field does not resolve
 * looked exactly like a KPI that is zero because nothing was detected.
 */
function schemaReadout(schema: SchemaCaps): AiSecResult["schema"] {
	const rowsDataset = schema.ai.dataset ? schema.datasets[schema.ai.dataset] : undefined;
	const fw = schema.datasets.firewallEventsAdaptive;
	const payloads = !!fw?.fields.includes("metadata") && !!fw.fields.includes("rayName");

	return {
		dataset: schema.ai.dataset,
		probedAt: schema.probedAt,
		notes: schema.notes,
		rows: [
			{
				id: "injection",
				label: "Prompt injection score",
				field: schema.ai.injectionScore,
				resolved: !!schema.ai.injectionScore,
				detail: "The injection KPI, histogram and score drill-down are empty without it.",
			},
			{
				id: "pii",
				label: "PII categories",
				field: schema.ai.piiCategories,
				resolved: !!schema.ai.piiCategories,
				detail: "The PII KPI and its category breakdown are empty without it.",
			},
			{
				id: "unsafe",
				label: "Unsafe topic categories",
				field: schema.ai.unsafeTopicCategories,
				resolved: !!schema.ai.unsafeTopicCategories,
				detail: "The unsafe-topic KPI and its breakdown are empty without it.",
			},
			{
				id: "custom",
				label: "Custom topics",
				field: schema.ai.customTopicScoresMin,
				// The field name alone is not enough: the KPI is fed by an aggregate alias that
				// only exists when the Groups dataset accepts the `_lt` operator.
				resolved: hasCustomTopicAggregate(schema),
				detail: schema.ai.customTopicScoresMin
					? "Field resolves, but httpRequestsAdaptiveGroups does not accept its _lt filter, so the aggregate KPI cannot be built."
					: "The custom-topic KPI and breakdown are empty without it.",
			},
			{
				id: "tokenCount",
				label: "Token count",
				field: schema.ai.tokenCount,
				resolved: !!schema.ai.tokenCount,
				detail: "The token-volume tile is hidden without it.",
			},
			{
				id: "ja4",
				label: "JA4 fingerprint",
				field: rowsDataset?.fields.includes("ja4") ? "ja4" : null,
				resolved: !!rowsDataset?.fields.includes("ja4"),
				detail: "Attacker sessions fall back to grouping by IP without it.",
			},
			{
				id: "payloads",
				label: "Payload logging join",
				field: payloads ? "firewallEventsAdaptive.metadata" : null,
				resolved: payloads,
				detail: "Logged prompts cannot be joined onto events without it, so no prompt text is decryptable here.",
			},
		],
	};
}

/**
 * One request's worth of work: probe the schema, fan out across the in-scope zones, aggregate.
 *
 * Zone fan-out and per-zone caching are the ported code's own; a zone that fails does not fail
 * the response, it comes back carrying its error so the Coverage table can say which zone is
 * broken rather than the whole page going blank.
 */
export async function loadAiSecurity(token: string, body: AiSecRequest, waitUntil: WaitUntil): Promise<AiSecResult> {
	const env: AiSecEnv = {
		CF_API_TOKEN: token,
		CF_ACCOUNT_ID: body.accountId,
		CF_TOKEN_FP: await tokenFingerprint(token),
	};

	const zones = await listZones(env);
	const params = toParams(body, zones);
	const schema = await getSchemaCaps(env, waitUntil);
	const selected = params.zoneId ? zones.filter((z) => z.id === params.zoneId) : zones;

	// 60s: the original tied this to the page's auto-refresh cadence. Flarelens reloads on
	// demand, so this is only here to keep a burst of re-renders from re-querying Analytics.
	const results = await fetchAllZones(env, schema, selected, params.range, waitUntil, 60);

	// A JA4 grouping the schema cannot back would hand buildDashboard a key that is null on every
	// event — an honest-looking but silently empty attacker-sessions table. Clamp before it gets
	// there rather than let that happen.
	const sessionKey = params.sessionKey === "ja4" && !hasJa4Field(schema) ? "ip" : params.sessionKey;

	const data = buildDashboard(results, params.range, params.detection, {
		hasTokenCount: !!schema.ai.tokenCount,
		// Resolving the ScoresMin field name is not enough: the KPI is fed by an aggregate alias
		// that only exists when the Groups dataset accepts the `_lt` operator. Gating on the field
		// name alone shows a hard 0 where the name resolves but the aggregate filter does not.
		hasCustomTopics: hasCustomTopicAggregate(schema),
		// kpiHref is deliberately omitted rather than stubbed. The original linked each detection
		// tile to its own /events page; here the events table is on the same route and the tiles
		// filter it in place, so BuildOptions' documented "omitted means the tile renders
		// unlinked" is exactly the behaviour wanted.
		narrow: params.narrow,
		sessionKey,
		endpointKey: params.endpointKey,
	});

	return {
		window: params.range,
		zones: zones.map((z) => ({ id: z.id, name: z.name })),
		data,
		schema: schemaReadout(schema),
	};
}

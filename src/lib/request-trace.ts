import { graphql, listZones } from "./ai-sec/cf/client";
import { getSchemaCaps, type SchemaCaps, type WaitUntil } from "./ai-sec/cf/schema";
import { tokenFingerprint } from "./ai-sec";
import type { AiSecEnv } from "./ai-sec/cf/types";

/**
 * Everything Cloudflare will tell us about one HTTP request, found by Ray ID.
 *
 * A Ray ID is the only identifier that survives from a browser's network tab into Cloudflare's
 * analytics, so it is what someone actually has in hand when asked "what happened to this
 * request?". The answer is spread across datasets — the request row, every WAF rule that fired,
 * and any Access login — and this pulls them together.
 *
 * Two honesty constraints shape the design:
 *
 * 1. `httpRequestsAdaptive` is **adaptively sampled**. A request that is genuinely missing from
 *    the sample looks exactly like one that never happened, so "not found" is reported as
 *    inconclusive rather than as an answer.
 * 2. Field availability differs by plan and token. The selection is built from a live schema
 *    probe, and whatever is missing is named in the response instead of silently absent.
 */

/** Fields worth showing if the schema has them, in the order they are rendered. */
const WANTED_FIELDS = [
	"datetime",
	"clientIP",
	"clientCountryName",
	"clientASNDescription",
	"clientAsn",
	"clientRequestHTTPHost",
	"clientRequestPath",
	"clientRequestQuery",
	"clientRequestHTTPMethodName",
	"clientRequestScheme",
	"clientRequestHTTPProtocol",
	"userAgent",
	"clientRequestUserAgent",
	"ja3Hash",
	"ja4",
	"clientSSLProtocol",
	"edgeResponseStatus",
	"originResponseStatus",
	"edgeResponseBytes",
	"edgeResponseContentTypeName",
	"edgeTimeToFirstByteMs",
	"originResponseDurationMs",
	"cacheStatus",
	"cacheCacheStatus",
	"coloCode",
	"edgeColoCode",
	"securityAction",
	"securitySource",
	"securityRuleId",
	"securityRuleDescription",
	"botScore",
	"botScoreSrcName",
	"wafAttackScore",
	"wafSqliAttackScore",
	"wafXssAttackScore",
	"wafRceAttackScore",
	"firewallForAiInjectionScore",
	"firewallForAiPiiCategories",
	"firewallForAiUnsafeTopicCategories",
] as const;

const FIREWALL_FIELDS = [
	"datetime",
	"action",
	"source",
	"ruleId",
	"rulesetId",
	"description",
	"clientRequestHTTPHost",
	"clientRequestPath",
	"clientCountryName",
	"clientIP",
	"matchIndex",
] as const;

export class RequestTraceError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "RequestTraceError";
	}
}

/**
 * Ray IDs are 16 hex characters. The dashboard and response headers often append the colo
 * (`a3633412999ba62b-BKK`), which is not part of the id the datasets store.
 */
export function normaliseRayId(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim().toLowerCase().split("-")[0];
	return /^[0-9a-f]{16}$/.test(trimmed) ? trimmed : null;
}

function availableFields(caps: SchemaCaps, dataset: "httpRequestsAdaptive" | "firewallEventsAdaptive", wanted: readonly string[]) {
	const present = new Set(caps.datasets[dataset]?.fields ?? []);
	const selected = wanted.filter((field) => present.has(field));
	const missing = wanted.filter((field) => !present.has(field));
	return { selected, missing };
}

/** The filter key for a ray differs between datasets and schema versions. */
function rayFilterKey(caps: SchemaCaps, dataset: "httpRequestsAdaptive" | "firewallEventsAdaptive"): string | null {
	const filters = new Set(caps.datasets[dataset]?.filters ?? []);
	for (const candidate of ["rayName", "rayId"]) {
		if (filters.has(candidate)) return candidate;
	}
	return null;
}

export interface RequestTraceResult {
	rayId: string;
	window: { since: string; until: string };
	zonesSearched: { id: string; name: string }[];
	foundIn?: { id: string; name: string };
	/** The request row, restricted to fields this schema exposes. */
	request?: Record<string, unknown>;
	firewallEvents: Record<string, unknown>[];
	/**
	 * Request-row fields this plan or token does not expose. Scoped to that dataset on purpose:
	 * a union across datasets would report a field as unavailable because the firewall row lacks
	 * it, while the request detail shows it perfectly well.
	 */
	unavailableFields: string[];
	/** Per-zone failures; a zone that errors does not fail the search. */
	errors: { zone: string; message: string }[];
}

export async function traceRequest(
	token: string,
	options: { accountId: string; rayId: string; zoneId?: string; minutes: number },
	waitUntil: WaitUntil,
): Promise<RequestTraceResult> {
	const env: AiSecEnv = {
		CF_API_TOKEN: token,
		CF_ACCOUNT_ID: options.accountId,
		CF_TOKEN_FP: await tokenFingerprint(token),
	};

	const until = new Date();
	until.setSeconds(0, 0);
	const since = new Date(until.getTime() - options.minutes * 60_000);
	const window = { since: since.toISOString(), until: until.toISOString() };

	const allZones = await listZones(env);
	const zones = options.zoneId ? allZones.filter((z) => z.id === options.zoneId) : allZones;
	if (!zones.length) {
		throw new RequestTraceError("No zones are visible to this token", 404);
	}

	const caps = await getSchemaCaps(env, waitUntil);
	const http = availableFields(caps, "httpRequestsAdaptive", WANTED_FIELDS);
	const firewall = availableFields(caps, "firewallEventsAdaptive", FIREWALL_FIELDS);
	const httpRayKey = rayFilterKey(caps, "httpRequestsAdaptive");
	const firewallRayKey = rayFilterKey(caps, "firewallEventsAdaptive");

	if (!httpRayKey && !firewallRayKey) {
		throw new RequestTraceError("This token's schema does not expose a Ray ID filter on either dataset", 502);
	}

	const rayField = caps.datasets.httpRequestsAdaptive?.fields.includes("rayName") ? "rayName" : "rayId";

	const errors: { zone: string; message: string }[] = [];
	let found: { zone: { id: string; name: string }; request?: Record<string, unknown>; firewallEvents: Record<string, unknown>[] } | null = null;

	// Zones are searched in order and the search stops at the first hit: a Ray ID belongs to one
	// request, so a second match would mean the id was reused, not that there is more to show.
	for (const zone of zones) {
		if (found) break;
		const parts: string[] = [];
		if (httpRayKey) {
			parts.push(`request: httpRequestsAdaptive(
				filter: { ${httpRayKey}: $ray, datetime_geq: $since, datetime_leq: $until }
				limit: 5
			) { ${rayField} ${http.selected.join(" ")} }`);
		}
		if (firewallRayKey) {
			parts.push(`firewall: firewallEventsAdaptive(
				filter: { ${firewallRayKey}: $ray, datetime_geq: $since, datetime_leq: $until }
				limit: 50
				orderBy: [datetime_ASC]
			) { ${firewall.selected.join(" ")} }`);
		}

		const query = `
query RequestTrace($zoneTag: string!, $ray: string!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      ${parts.join("\n      ")}
    }
  }
}`;

		try {
			const data = await graphql<{
				viewer?: { zones?: { request?: Record<string, unknown>[]; firewall?: Record<string, unknown>[] }[] };
			}>(env, query, { zoneTag: zone.id, ray: options.rayId, since: window.since, until: window.until });

			const result = data.viewer?.zones?.[0];
			const request = result?.request?.[0];
			const firewallEvents = result?.firewall ?? [];
			if (request || firewallEvents.length) {
				found = { zone: { id: zone.id, name: zone.name }, request, firewallEvents };
			}
		} catch (err) {
			errors.push({ zone: zone.name, message: err instanceof Error ? err.message : "Query failed" });
		}
	}

	return {
		rayId: options.rayId,
		window,
		zonesSearched: zones.map((z) => ({ id: z.id, name: z.name })),
		foundIn: found?.zone,
		request: found?.request,
		firewallEvents: found?.firewallEvents ?? [],
		unavailableFields: http.missing,
		errors,
	};
}

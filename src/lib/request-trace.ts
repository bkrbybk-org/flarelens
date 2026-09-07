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

/**
 * Scalar-ish GraphQL kinds. Selecting an object field without a subselection makes the whole
 * query invalid, so the all-fields sweep is restricted to types that need no subselection.
 */
const SELECTABLE_KINDS = new Set(["SCALAR", "ENUM"]);

/**
 * Cloudflare rejects a zone query selecting more than this many fields. The sweep can easily
 * exceed it, so the extras are budgeted: curated fields keep their place and the remainder fill
 * whatever is left.
 */
const MAX_QUERY_FIELDS = 70;

const ROW_TYPE_FIELDS_QUERY = `
query RowFields($name: String!) {
  __type(name: $name) {
    fields {
      name
      type { kind name ofType { kind name ofType { kind name } } }
    }
  }
}`;

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
	"metadata",
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
	/** Extra row fields discovered by the schema sweep, beyond the curated groups. */
	extraFields: string[];
	/** Fields this zone is not entitled to, dropped so one of them cannot fail the whole query. */
	droppedFields: string[];
	/** Per-zone failures; a zone that errors does not fail the search. */
	errors: { zone: string; message: string }[];
}

/**
 * Every field on the row type that can be selected without a subselection.
 *
 * The curated list above is what gets laid out and labelled; this is what makes "and everything
 * else Cloudflare has" true without hard-coding a field list that goes stale each time Cloudflare
 * adds one. Object fields are excluded because selecting one bare invalidates the query.
 */
async function scalarFieldsOf(env: AiSecEnv, typeName: string): Promise<string[]> {
	interface TypeRefNode { kind: string; name: string | null; ofType?: TypeRefNode | null }
	const unwrapKind = (ref: TypeRefNode | null | undefined): string => {
		let node = ref;
		while (node && (node.kind === "NON_NULL" || node.kind === "LIST") && node.ofType) node = node.ofType;
		return node?.kind ?? "";
	};
	try {
		const data = await graphql<{ __type?: { fields?: { name: string; type: TypeRefNode }[] } }>(
			env,
			ROW_TYPE_FIELDS_QUERY,
			{ name: typeName },
		);
		return (data.__type?.fields ?? []).filter((f) => SELECTABLE_KINDS.has(unwrapKind(f.type))).map((f) => f.name);
	} catch {
		// A failed sweep is not fatal: the curated selection still answers the question.
		return [];
	}
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

	// Everything else the row type exposes, so the page can show detail this code has never
	// heard of rather than a fixed list that ages.
	const httpTypeName = caps.datasets.httpRequestsAdaptive?.typeName;
	const sweep = httpTypeName ? await scalarFieldsOf(env, httpTypeName) : [];
	// Budget: the firewall selection, the ray field and a little headroom come off the top.
	const budget = Math.max(0, MAX_QUERY_FIELDS - firewall.selected.length - 4 - http.selected.length);
	const extraFields = sweep
		.filter((field) => !http.selected.includes(field) && field !== rayField)
		.slice(0, budget);
	const requestSelection = [...http.selected, ...extraFields];

	const errors: { zone: string; message: string }[] = [];
	const droppedFields: string[] = [];
	let found: { zone: { id: string; name: string }; request?: Record<string, unknown>; firewallEvents: Record<string, unknown>[] } | null = null;

	/**
	 * A field can exist in the schema and still be refused for a zone that is not entitled to it
	 * — fraud detection fields do this — and one such field rejects the entire query. Cloudflare
	 * names the offender, so it is dropped and the query retried rather than losing every swept
	 * field to one of them.
	 */
	function offendingField(message: string): string | null {
		const match = message.match(/does not have access to the field '([^']+)'/i);
		return match ? match[1].toLowerCase() : null;
	}

	// Zones are searched in order and the search stops at the first hit: a Ray ID belongs to one
	// request, so a second match would mean the id was reused, not that there is more to show.
	for (const zone of zones) {
		if (found) break;

		let selection = [...requestSelection];
		let lastError = "";

		// Bounded: each attempt removes exactly one refused field, and a zone that keeps
		// refusing is reported rather than retried forever.
		for (let attempt = 0; attempt < 12; attempt++) {
			const parts: string[] = [];
			if (httpRayKey) {
				parts.push(`request: httpRequestsAdaptive(
				filter: { ${httpRayKey}: $ray, datetime_geq: $since, datetime_leq: $until }
				limit: 5
			) { ${rayField} ${selection.join(" ")} }`);
			}
			if (firewallRayKey) {
				// `metadata` is a key/value list: it carries matched_vars and, for payload-logging
				// rules, the encrypted request body.
				const firewallSelection = firewall.selected
					.map((field) => (field === "metadata" ? "metadata { key value }" : field))
					.join(" ");
				parts.push(`firewall: firewallEventsAdaptive(
				filter: { ${firewallRayKey}: $ray, datetime_geq: $since, datetime_leq: $until }
				limit: 50
				orderBy: [datetime_ASC]
			) { ${firewallSelection} }`);
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
				lastError = "";
				break;
			} catch (err) {
				lastError = err instanceof Error ? err.message : "Query failed";
				// Cloudflare also enforces a field-count ceiling, and states it. Trim to what it
				// asks for rather than giving up on the whole trace.
				const ceiling = lastError.match(/can't be more than (\d+)/i);
				if (ceiling) {
					const limit = Math.max(10, Number(ceiling[1]) - firewall.selected.length - 4);
					if (selection.length > limit) {
						selection = selection.slice(0, limit);
						continue;
					}
				}

				const refused = offendingField(lastError);
				const index = refused ? selection.findIndex((field) => field.toLowerCase() === refused) : -1;
				if (index === -1) break;
				if (!droppedFields.includes(selection[index])) droppedFields.push(selection[index]);
				selection = selection.filter((_, i) => i !== index);
			}
		}

		if (lastError) errors.push({ zone: zone.name, message: lastError });
	}

	return {
		rayId: options.rayId,
		window,
		zonesSearched: zones.map((z) => ({ id: z.id, name: z.name })),
		foundIn: found?.zone,
		request: found?.request,
		firewallEvents: found?.firewallEvents ?? [],
		unavailableFields: http.missing,
		extraFields,
		droppedFields,
		errors,
	};
}

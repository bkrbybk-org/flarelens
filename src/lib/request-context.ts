import { upstreamFetch } from "./cf-rest";

/**
 * The surroundings of one traced request — the questions a false-positive or false-negative report
 * raises right after "which rule?":
 *
 * - **Impact** of the drafted change: how many requests match it (host and path, plus the client IP
 *   for a drafted block), what Cloudflare did to them, from how many clients, and — for an
 *   exception — how many of the deciding rule's events it would release.
 * - **The deciding rule elsewhere**: how often it fired, how much of that was this client or this
 *   path, and the top hosts, paths, countries and networks it hit. One-off, or a pattern?
 * - **This client's timeline**: its requests either side of this one.
 *
 * Counts come from the `*Groups` datasets, which are Cloudflare's sample-adjusted totals. The
 * timeline reads request rows, which are sampled — the page says so. Every part runs on its own:
 * one failing (a plan without the dataset, say) leaves the others standing.
 */

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const TIMELINE_MINUTES = 60;
const TOP = 5;
/** Distinct clients are counted by grouping on IP; past this many the page says "N+". */
export const DISTINCT_CAP = 1000;

export interface ContextInput {
	zoneId: string;
	since: string;
	until: string;
	/** The request's own time, for the timeline. */
	around?: string;
	ruleId?: string;
	clientIP?: string;
	host?: string;
	path?: string;
	/** A drafted block also narrows by client IP; an exception does not. */
	impactIncludesIp?: boolean;
}

export interface Top {
	value: string;
	count: number;
}

export interface RequestContext {
	window: { since: string; until: string };
	impact?: {
		filter: { host?: string; path?: string; clientIP?: string };
		requests: number;
		byAction: Record<string, number>;
		distinctClients: number;
		distinctCapped: boolean;
		/** Events of the deciding rule the filter covers — what an exception would release. */
		ruleEvents?: number;
	};
	rule?: {
		ruleId: string;
		total: number;
		byAction: Record<string, number>;
		sameClient: number;
		samePath: number;
		topHosts: Top[];
		topPaths: Top[];
		topCountries: Top[];
		topNetworks: Top[];
	};
	timeline?: { since: string; until: string; rows: Record<string, unknown>[] };
	errors: { part: string; message: string }[];
}

interface GroupRow {
	count?: number;
	dimensions?: Record<string, string | number | undefined>;
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const response = await upstreamFetch(GRAPHQL, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	let body: { errors?: { message?: string }[]; data?: T };
	try {
		body = await response.json();
	} catch {
		throw new Error("Cloudflare GraphQL returned a non-JSON response");
	}
	if (!response.ok) throw new Error(body.errors?.[0]?.message || `HTTP ${response.status}`);
	if (body.errors?.length) throw new Error(body.errors[0]?.message || "GraphQL query failed");
	if (!body.data) throw new Error("GraphQL returned no data");
	return body.data;
}

type Dataset = "httpRequestsAdaptiveGroups" | "firewallEventsAdaptiveGroups";
const FILTER_TYPE: Record<Dataset, string> = {
	httpRequestsAdaptiveGroups: "ZoneHttpRequestsAdaptiveGroupsFilter_InputObject",
	firewallEventsAdaptiveGroups: "ZoneFirewallEventsAdaptiveGroupsFilter_InputObject",
};

/** One grouped read. The filter travels as a variable, never spliced into the query text. */
async function groups(token: string, zoneId: string, dataset: Dataset, filter: Record<string, unknown>, dimensions: string[], limit: number): Promise<GroupRow[]> {
	const dims = dimensions.length ? `dimensions { ${dimensions.join(" ")} }` : "";
	const query = `query Ctx($tag: string!, $filter: ${FILTER_TYPE[dataset]}) {
  viewer { zones(filter: { zoneTag: $tag }) { ${dataset}(filter: $filter, limit: ${limit}, orderBy: [count_DESC]) { count ${dims} } } }
}`;
	const data = await gql<{ viewer?: { zones?: Record<string, GroupRow[] | undefined>[] } }>(token, query, { tag: zoneId, filter });
	return data.viewer?.zones?.[0]?.[dataset] ?? [];
}

const sum = (rows: GroupRow[]) => rows.reduce((n, r) => n + (r.count ?? 0), 0);

function byDimension(rows: GroupRow[], key: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const row of rows) {
		const value = String(row.dimensions?.[key] ?? "unknown") || "unknown";
		out[value] = (out[value] ?? 0) + (row.count ?? 0);
	}
	return out;
}

function top(rows: GroupRow[], key: string, label?: (row: GroupRow) => string): Top[] {
	return rows
		.filter((row) => row.dimensions?.[key] !== undefined && row.dimensions?.[key] !== "")
		.slice(0, TOP)
		.map((row) => ({ value: label ? label(row) : String(row.dimensions?.[key]), count: row.count ?? 0 }));
}

const TIMELINE_FIELDS = [
	"datetime",
	"rayName",
	"clientRequestHTTPMethodName",
	"clientRequestHTTPHost",
	"clientRequestPath",
	"edgeResponseStatus",
	"securityAction",
	"securitySource",
];

export async function requestContext(token: string, input: ContextInput): Promise<RequestContext> {
	const window = { since: input.since, until: input.until };
	const base = { datetime_geq: input.since, datetime_leq: input.until };
	const errors: RequestContext["errors"] = [];
	const result: RequestContext = { window, errors };
	const attempt = async (part: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (err) {
			errors.push({ part, message: err instanceof Error ? err.message : "Query failed" });
		}
	};

	const parts: Promise<void>[] = [];

	if (input.host || input.path) {
		const filter: Record<string, unknown> = { ...base };
		const shown: NonNullable<RequestContext["impact"]>["filter"] = {};
		if (input.host) filter.clientRequestHTTPHost = shown.host = input.host;
		if (input.path) filter.clientRequestPath = shown.path = input.path;
		if (input.impactIncludesIp && input.clientIP) filter.clientIP = shown.clientIP = input.clientIP;
		parts.push(
			attempt("impact", async () => {
				const ruleFilter = input.ruleId ? { ...filter, ruleId: input.ruleId } : null;
				const [actions, clients, ruleRows] = await Promise.all([
					groups(token, input.zoneId, "httpRequestsAdaptiveGroups", filter, ["securityAction"], 50),
					groups(token, input.zoneId, "httpRequestsAdaptiveGroups", filter, ["clientIP"], DISTINCT_CAP),
					ruleFilter ? groups(token, input.zoneId, "firewallEventsAdaptiveGroups", ruleFilter, [], 1) : Promise.resolve(null),
				]);
				result.impact = {
					filter: shown,
					requests: sum(actions),
					byAction: byDimension(actions, "securityAction"),
					distinctClients: clients.length,
					distinctCapped: clients.length >= DISTINCT_CAP,
					ruleEvents: ruleRows ? sum(ruleRows) : undefined,
				};
			}),
		);
	}

	if (input.ruleId) {
		const ruleId = input.ruleId;
		const filter = { ...base, ruleId };
		parts.push(
			attempt("rule", async () => {
				const [actions, sameClient, samePath, hosts, paths, countries, networks] = await Promise.all([
					groups(token, input.zoneId, "firewallEventsAdaptiveGroups", filter, ["action"], 20),
					input.clientIP ? groups(token, input.zoneId, "firewallEventsAdaptiveGroups", { ...filter, clientIP: input.clientIP }, [], 1) : Promise.resolve([]),
					input.path ? groups(token, input.zoneId, "firewallEventsAdaptiveGroups", { ...filter, clientRequestPath: input.path }, [], 1) : Promise.resolve([]),
					groups(token, input.zoneId, "firewallEventsAdaptiveGroups", filter, ["clientRequestHTTPHost"], TOP),
					groups(token, input.zoneId, "firewallEventsAdaptiveGroups", filter, ["clientRequestPath"], TOP),
					groups(token, input.zoneId, "firewallEventsAdaptiveGroups", filter, ["clientCountryName"], TOP),
					groups(token, input.zoneId, "firewallEventsAdaptiveGroups", filter, ["clientAsn", "clientASNDescription"], TOP),
				]);
				result.rule = {
					ruleId,
					total: sum(actions),
					byAction: byDimension(actions, "action"),
					sameClient: sum(sameClient),
					samePath: sum(samePath),
					topHosts: top(hosts, "clientRequestHTTPHost"),
					topPaths: top(paths, "clientRequestPath"),
					topCountries: top(countries, "clientCountryName"),
					topNetworks: top(networks, "clientAsn", (row) => `AS${row.dimensions?.clientAsn}${row.dimensions?.clientASNDescription ? ` ${row.dimensions.clientASNDescription}` : ""}`),
				};
			}),
		);
	}

	const around = input.around ? new Date(input.around) : null;
	if (input.clientIP && around && !Number.isNaN(around.getTime())) {
		const since = new Date(around.getTime() - TIMELINE_MINUTES * 60_000).toISOString();
		const until = new Date(around.getTime() + TIMELINE_MINUTES * 60_000).toISOString();
		parts.push(
			attempt("timeline", async () => {
				const query = `query Timeline($tag: string!, $filter: ZoneHttpRequestsAdaptiveFilter_InputObject) {
  viewer { zones(filter: { zoneTag: $tag }) { httpRequestsAdaptive(filter: $filter, limit: 100, orderBy: [datetime_ASC]) { ${TIMELINE_FIELDS.join(" ")} } } }
}`;
				const data = await gql<{ viewer?: { zones?: { httpRequestsAdaptive?: Record<string, unknown>[] }[] } }>(token, query, {
					tag: input.zoneId,
					filter: { clientIP: input.clientIP, datetime_geq: since, datetime_leq: until },
				});
				result.timeline = { since, until, rows: data.viewer?.zones?.[0]?.httpRequestsAdaptive ?? [] };
			}),
		);
	}

	await Promise.all(parts);
	return result;
}

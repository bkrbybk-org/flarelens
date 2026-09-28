/**
 * Full WAF event counts from `firewallEventsAdaptiveGroups`.
 *
 * The event rows WAF Analytics reads (`firewallEventsAdaptive`) are adaptively sampled: each row
 * stands for `sampleInterval` events, and on the account this was built against that interval ran
 * from 1.7 to 15 per bucket. Counting rows therefore undercounts — 1,406 blocks counted from rows
 * against 5,741 reported by the groups dataset for the same 24 hours (2026-09-28) — and undercounts
 * by different amounts in different windows, which is why a 30-day window used to show fewer events
 * than a 7-day one. The groups dataset returns Cloudflare's own sample-adjusted counts, so the
 * headline numbers, the timeline and the country breakdown come from here; the rows stay what they
 * are good for: which rule, which host, which path.
 *
 * Idea ported from cf-attack-analyzer, which read this dataset for its totals.
 */

import { upstreamFetch } from "./cf-rest";

/** The actions WAF Analytics counts as its headline. Others (skip, AI Labyrinth) are reported apart. */
export const HEADLINE_ACTIONS = ["block", "challenge", "managed_challenge", "js_challenge", "log"];

/** Up to 6 hours in 15-minute buckets, hourly beyond — at most 720 buckets for 30 days. */
export function bucketDimension(minutes: number): "datetimeFifteenMinutes" | "datetimeHour" {
	return minutes <= 360 ? "datetimeFifteenMinutes" : "datetimeHour";
}

export interface WafAggregates {
	/** Every action the dataset reports, headline or not, with its full count. */
	byAction: Record<string, number>;
	/** Sum over {@link HEADLINE_ACTIONS}. */
	total: number;
	series: { ts: string; byAction: Record<string, number> }[];
	bucket: "15m" | "1h";
	/** Headline actions only, most first. Country as Cloudflare reports it: an ISO code. */
	countries: { country: string; count: number }[];
	/** Average events each sampled row stands for, across the window — 1 means unsampled. */
	sampleInterval: number | null;
}

interface GroupRow {
	count?: number;
	avg?: { sampleInterval?: number };
	dimensions?: { action?: string; clientCountryName?: string; datetimeHour?: string; datetimeFifteenMinutes?: string };
}

type Scope = { kind: "account"; id: string } | { kind: "zone"; id: string };

function groupsQuery(scope: Scope, dimensions: string, filterExtra: string, limit: number, orderBy: string): string {
	const node = scope.kind === "zone" ? "zones(filter: { zoneTag: $tag })" : "accounts(filter: { accountTag: $tag })";
	return `query WafGroups($tag: string!, $since: Time!, $until: Time!${filterExtra ? ", $actions: [string!]" : ""}) {
  viewer {
    ${node} {
      firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until${filterExtra} }
        limit: ${limit}
        orderBy: [${orderBy}]
      ) { count avg { sampleInterval } dimensions { ${dimensions} } }
    }
  }
}`;
}

async function runGroups(token: string, scope: Scope, query: string, variables: Record<string, unknown>): Promise<GroupRow[]> {
	const response = await upstreamFetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	let body: { errors?: { message?: string }[]; data?: { viewer?: Record<string, { firewallEventsAdaptiveGroups?: GroupRow[] }[]> } };
	try {
		body = await response.json();
	} catch {
		throw new Error("Cloudflare GraphQL returned a non-JSON response");
	}
	if (!response.ok) throw new Error(body.errors?.[0]?.message || `HTTP ${response.status}`);
	if (body.errors?.length) throw new Error(body.errors[0]?.message || "GraphQL query failed");
	const nodes = body.data?.viewer?.[scope.kind === "zone" ? "zones" : "accounts"] ?? [];
	return nodes[0]?.firewallEventsAdaptiveGroups ?? [];
}

/** Pure: fold the three groups reads into what the page shows. */
export function buildAggregates(actionRows: GroupRow[], seriesRows: GroupRow[], countryRows: GroupRow[], minutes: number): WafAggregates {
	const byAction: Record<string, number> = {};
	let weighted = 0;
	let counted = 0;
	for (const row of actionRows) {
		const action = row.dimensions?.action || "unknown";
		const count = row.count ?? 0;
		byAction[action] = (byAction[action] ?? 0) + count;
		if (typeof row.avg?.sampleInterval === "number" && count > 0) {
			weighted += row.avg.sampleInterval * count;
			counted += count;
		}
	}
	const dimension = bucketDimension(minutes);
	const buckets = new Map<string, Record<string, number>>();
	for (const row of seriesRows) {
		const ts = row.dimensions?.[dimension];
		const action = row.dimensions?.action;
		if (!ts || !action) continue;
		const bucket = buckets.get(ts) ?? {};
		bucket[action] = (bucket[action] ?? 0) + (row.count ?? 0);
		buckets.set(ts, bucket);
	}
	return {
		byAction,
		total: HEADLINE_ACTIONS.reduce((sum, action) => sum + (byAction[action] ?? 0), 0),
		series: [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([ts, counts]) => ({ ts, byAction: counts })),
		bucket: dimension === "datetimeHour" ? "1h" : "15m",
		countries: countryRows
			.filter((row) => row.dimensions?.clientCountryName)
			.map((row) => ({ country: row.dimensions!.clientCountryName as string, count: row.count ?? 0 })),
		sampleInterval: counted ? weighted / counted : null,
	};
}

export async function fetchWafAggregates(token: string, scope: Scope, since: string, until: string, minutes: number): Promise<WafAggregates> {
	const variables = { tag: scope.id, since, until };
	const headline = { ...variables, actions: HEADLINE_ACTIONS };
	const actionFilter = ", action_in: $actions";
	const [actionRows, seriesRows, countryRows] = await Promise.all([
		// Every action — skip and AI Labyrinth included — so the page can say what it leaves out.
		runGroups(token, scope, groupsQuery(scope, "action", "", 100, "count_DESC"), variables),
		runGroups(token, scope, groupsQuery(scope, `action ${bucketDimension(minutes)}`, actionFilter, 10000, `${bucketDimension(minutes)}_ASC`), headline),
		runGroups(token, scope, groupsQuery(scope, "clientCountryName", actionFilter, 10, "count_DESC"), headline),
	]);
	return buildAggregates(actionRows, seriesRows, countryRows, minutes);
}

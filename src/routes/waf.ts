// ---------------------------------------------------------------------------
// WAF analytics (ported from cf-waf-rules-analyzer)

import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { collectRulesetsForScope, UpstreamError, type RuleMetaMap, type RulesetScope } from "../lib/waf-meta";
import { fetchCloudflareAll, mapWithConcurrency } from "../lib/cf-rest";
import type { CfZone } from "../cf-types";
import { validHexId } from "../http";
import type { App } from "../env";

const GRAPHQL_EVENT_LIMIT = 10000;
// firewallEventsAdaptive caps at 10k rows/query; cursor-paginate by datetime.
const MAX_EVENT_PAGES = 5;
const MIN_LOOKBACK_MINUTES = 5;
const MAX_LOOKBACK_MINUTES = 43200;
const WAF_ACTIONS = ["block", "challenge", "managed_challenge", "js_challenge", "log"];

const FIREWALL_EVENT_FIELDS = `
        action
        clientCountryName
        clientIP
        clientRequestHTTPHost
        clientRequestPath
        datetime
        rayName
        ruleId
        source`;

const accountFirewallEventsQuery = `
query AccountFirewallEvents($accountTag: string!, $since: Time!, $before: Time!, $actions: [string!], $limit: int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      firewallEventsAdaptive(
        filter: { datetime_geq: $since, datetime_leq: $before, action_in: $actions }
        limit: $limit
        orderBy: [datetime_DESC]
      ) {${FIREWALL_EVENT_FIELDS}
      }
    }
  }
}`;

const zoneFirewallEventsQuery = `
query ZoneFirewallEvents($zoneTag: string!, $since: Time!, $before: Time!, $actions: [string!], $limit: int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(
        filter: { datetime_geq: $since, datetime_leq: $before, action_in: $actions }
        limit: $limit
        orderBy: [datetime_DESC]
      ) {${FIREWALL_EVENT_FIELDS}
      }
    }
  }
}`;

interface FirewallEvent {
	action?: string;
	clientCountryName?: string;
	clientIP?: string;
	clientRequestHTTPHost?: string;
	clientRequestPath?: string;
	datetime?: string;
	rayName?: string;
	ruleId?: string;
	source?: string;
}

interface GraphqlEnvelope {
	errors?: { message?: string }[];
	data?: {
		viewer?: {
			accounts?: { firewallEventsAdaptive?: FirewallEvent[] }[];
			zones?: { firewallEventsAdaptive?: FirewallEvent[] }[];
		};
	};
}

export function registerWafRoutes(app: App): void {
	app.post("/api/waf/events", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		let body: { accountId?: string; zoneId?: string; minutes?: number };
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
		const requested = Number(body.minutes || 360);
		const minutes = Math.min(MAX_LOOKBACK_MINUTES, Math.max(MIN_LOOKBACK_MINUTES, Number.isFinite(requested) ? requested : 360));
		const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
		const query = zoneId ? zoneFirewallEventsQuery : accountFirewallEventsQuery;

		// Cursor pagination: walk backwards from "now" with datetime_leq. Pages
		// overlap on boundary seconds, so events are deduped by ray+rule+action.
		const events: Omit<FirewallEvent, "rayName">[] = [];
		const seen = new Set<string>();
		let before = new Date(Date.now() + 60 * 1000).toISOString();
		let pages = 0;
		let lastBatchFull = false;

		for (let page = 0; page < MAX_EVENT_PAGES; page++) {
			const variables = zoneId
				? { zoneTag: zoneId, since, before, actions: WAF_ACTIONS, limit: GRAPHQL_EVENT_LIMIT }
				: { accountTag: accountId, since, before, actions: WAF_ACTIONS, limit: GRAPHQL_EVENT_LIMIT };

			const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
				method: "POST",
				headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ query, variables }),
			});
			if (response.status === 401 || response.status === 403) {
				return c.json({ success: false, errors: [{ message: "Cloudflare API request failed" }] }, response.status);
			}
			let upstream: GraphqlEnvelope;
			try {
				upstream = await response.json();
			} catch {
				return c.json({ success: false, errors: [{ message: "Cloudflare GraphQL returned non-JSON response" }] }, 502);
			}
			if (upstream.errors?.length) {
				return c.json({ success: false, errors: [{ message: upstream.errors[0]?.message || "GraphQL query failed" }] }, 502);
			}

			const batch = zoneId
				? upstream.data?.viewer?.zones?.[0]?.firewallEventsAdaptive || []
				: upstream.data?.viewer?.accounts?.[0]?.firewallEventsAdaptive || [];
			pages++;
			lastBatchFull = batch.length >= GRAPHQL_EVENT_LIMIT;

			let added = 0;
			for (const event of batch) {
				const key = event.rayName ? `${event.rayName}:${event.ruleId}:${event.action}` : "";
				if (key) {
					if (seen.has(key)) continue;
					seen.add(key);
				}
				// rayName exists only for dedupe; keep the payload lean
				const { rayName, ...rest } = event;
				events.push(rest);
				added++;
			}

			if (!lastBatchFull) break;
			const oldest = batch[batch.length - 1]?.datetime;
			// No progress means >10k events share one second; bail rather than loop
			if (!oldest || oldest === before || added === 0) break;
			before = oldest;
		}

		return c.json({
			success: true,
			result: events,
			diagnostics: {
				scope: zoneId ? "zone" : "account",
				since,
				minutes,
				pages,
				eventCount: events.length,
				truncated: pages >= MAX_EVENT_PAGES && lastBatchFull,
			},
		});
	});

	app.get("/api/waf/rulesets", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		const accountId = validHexId(c.req.query("account_id"));
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
		}
		const zoneId = c.req.query("zone_id") ? validHexId(c.req.query("zone_id")) : null;
		if (c.req.query("zone_id") && !zoneId) {
			return c.json({ success: false, errors: [{ message: "Invalid zone_id" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId, zoneId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}
		const includeZones = c.req.query("include_zones") === "1";

		const scopes: RulesetScope[] = [{ kind: "accounts", id: accountId, source: "account" }];
		if (zoneId) {
			scopes.push({ kind: "zones", id: zoneId, source: "zone" });
		} else if (includeZones) {
			const zonesRes = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
			if (zonesRes.status === 200) {
				scopes.push(...zonesRes.result.map((z) => ({ kind: "zones" as const, id: z.id, source: `zone:${z.name || z.id}` })));
			}
		}

		const meta: RuleMetaMap = {};
		try {
			// Each scope gets its own map so completion order can't race the
			// last-write-wins merge below; scopes run concurrently, but the merge
			// walks `scopes` in original (account-first-then-zones) order so a
			// zone entry still overrides an account entry for the same rule id,
			// exactly as the old sequential loop did.
			const perScope = await mapWithConcurrency(scopes, 5, async (scope) => {
				const scopeMeta: RuleMetaMap = {};
				await collectRulesetsForScope(scope, token, scopeMeta);
				return scopeMeta;
			});
			for (const scopeMeta of perScope) {
				Object.assign(meta, scopeMeta);
			}
		} catch (err) {
			if (err instanceof UpstreamError) {
				const status = err.status === 401 || err.status === 403 || err.status === 429 ? err.status : 502;
				return c.json({ success: false, errors: [{ message: err.message }] }, status as 502);
			}
			throw err;
		}

		return c.json({ success: true, result: meta });
	});
}

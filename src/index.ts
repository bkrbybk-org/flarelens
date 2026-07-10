import { Hono } from "hono";
import { collectRulesetsForScope, UpstreamError, type RuleMetaMap, type RulesetScope } from "./lib/waf-meta";
import {
	ALLOWED_RANGES,
	assembleAnalytics,
	computeInsights,
	fetchRuleShells,
	fetchVersioning,
	fetchZoneName,
	type CacheCredentials,
} from "./lib/cache-analysis";

interface Env {
	ASSETS: Fetcher;
}

interface CfResultInfo {
	page?: number;
	per_page?: number;
	total_pages?: number;
	total_count?: number;
}

interface CfListResponse<T> {
	success: boolean;
	errors?: { code?: number; message: string }[];
	result?: T[];
	result_info?: CfResultInfo;
}

interface CfIdp {
	id: string;
	name?: string;
	type?: string;
}

interface CfPolicy {
	id: string;
	name?: string;
	decision?: string;
	reusable?: boolean;
	include?: unknown[];
	exclude?: unknown[];
	require?: unknown[];
}

interface CfGroup {
	id: string;
	name?: string;
}

interface CfApp {
	id: string;
	name?: string;
	domain?: string;
	self_hosted_domains?: string[];
	[key: string]: unknown;
}

interface CfZone {
	id: string;
	name?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
	"Content-Security-Policy": [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"font-src 'self'",
		"img-src 'self' data:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	].join("; "),
};

function getAuthToken(authorization: string | undefined): string | null {
	if (!authorization || !authorization.startsWith("Bearer ")) {
		return null;
	}
	return authorization.substring(7).trim();
}

async function fetchCloudflare<T>(path: string, token: string): Promise<{ status: number; data: CfListResponse<T> }> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	const status = response.status;
	let data: CfListResponse<T>;
	try {
		data = await response.json();
	} catch {
		data = { success: false, errors: [{ message: "Failed to parse Cloudflare API response" }] };
	}
	return { status, data };
}

const PER_PAGE = 100;

// Fetch every page of a list endpoint and concatenate results.
async function fetchCloudflareAll<T>(
	path: string,
	token: string,
): Promise<{ status: number; result: T[]; errors?: { message: string }[] }> {
	const sep = path.includes("?") ? "&" : "?";
	const all: T[] = [];
	let page = 1;

	while (true) {
		const { status, data } = await fetchCloudflare<T>(`${path}${sep}per_page=${PER_PAGE}&page=${page}`, token);
		if (status !== 200 || !data.success) {
			return { status, result: [], errors: data.errors };
		}
		all.push(...(data.result || []));

		const totalPages = data.result_info?.total_pages ?? 1;
		if (page >= totalPages || (data.result || []).length === 0) {
			return { status: 200, result: all };
		}
		page++;
	}
}

// Run tasks with bounded concurrency (Workers allow ~6 simultaneous connections per host).
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

const app = new Hono<{ Bindings: Env }>();

// Security headers on every response; API responses are token-derived, never cacheable.
// Asset responses arrive with immutable headers, so rewrap before mutating.
app.use("*", async (c, next) => {
	await next();
	const res = new Response(c.res.body, c.res);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		res.headers.set(key, value);
	}
	if (c.req.path.startsWith("/api/")) {
		res.headers.set("Cache-Control", "no-store");
	}
	c.res = res;
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/accounts", async (c) => {
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
	const { status, data } = await fetchCloudflare("/accounts", token);
	return c.json(data, status as 200);
});

app.get("/api/zones", async (c) => {
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
	const accountId = c.req.query("account_id");
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
	}
	const res = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
	if (res.status !== 200) {
		return c.json({ success: false, errors: res.errors || [{ message: "Failed to fetch zones" }] }, res.status as 200);
	}
	return c.json({ success: true, result: res.result.map((z) => ({ id: z.id, name: z.name })) });
});

app.get("/api/data", async (c) => {
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
	const accountId = c.req.query("account_id");
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
	}

	// 1. Fetch apps, identity providers, groups, and reusable policies
	const [appsRes, idpsRes, groupsRes, reusableRes] = await Promise.all([
		fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, token),
		fetchCloudflareAll<CfIdp>(`/accounts/${accountId}/access/identity_providers`, token),
		fetchCloudflareAll<CfGroup>(`/accounts/${accountId}/access/groups`, token),
		fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/policies`, token),
	]);

	if (appsRes.status !== 200) {
		return c.json(
			{ success: false, errors: appsRes.errors || [{ message: "Failed to fetch applications" }] },
			appsRes.status as 200,
		);
	}
	if (idpsRes.status !== 200) {
		return c.json(
			{ success: false, errors: idpsRes.errors || [{ message: "Failed to fetch identity providers" }] },
			idpsRes.status as 200,
		);
	}

	const apps = appsRes.result;
	const idps = idpsRes.result;
	// Groups and reusable policies are enrichment data; tokens without those
	// read scopes still get the core app/policy view.
	const groups = groupsRes.status === 200 ? groupsRes.result : [];
	const reusablePolicies = reusableRes.status === 200 ? reusableRes.result : [];

	// 2. Fetch policies for all applications with bounded concurrency
	const policyResults = await mapWithConcurrency(apps, 5, async (appItem) => {
		const res = await fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/apps/${appItem.id}/policies`, token);
		if (res.status === 200) {
			return { appId: appItem.id, policies: res.result, error: false };
		}
		return { appId: appItem.id, policies: [] as CfPolicy[], error: true };
	});
	const policyMap = new Map(policyResults.map((p) => [p.appId, p]));

	// 3. Merge policies into applications and map fields
	const enrichedApps = apps.map((appItem) => {
		const entry = policyMap.get(appItem.id);
		return {
			...appItem,
			policies: entry?.policies || [],
			policies_error: entry?.error || false,
			self_hosted_domains: appItem.self_hosted_domains || (appItem.domain ? [appItem.domain] : []),
		};
	});

	return c.json({
		success: true,
		result: {
			apps: enrichedApps,
			idps,
			groups,
			reusable_policies: reusablePolicies,
		},
	});
});

// ---------------------------------------------------------------------------
// WAF analytics (ported from cf-waf-rules-analyzer)

const HEX_ID_PATTERN = /^[a-f0-9]{32}$/i;
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

function validHexId(value: string | undefined | null): string | null {
	const normalized = String(value || "").trim();
	return HEX_ID_PATTERN.test(normalized) ? normalized : null;
}

app.post("/api/waf/events", async (c) => {
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
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
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
	const accountId = validHexId(c.req.query("account_id"));
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
	}
	const zoneId = c.req.query("zone_id") ? validHexId(c.req.query("zone_id")) : null;
	if (c.req.query("zone_id") && !zoneId) {
		return c.json({ success: false, errors: [{ message: "Invalid zone_id" }] }, 400);
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
		for (const scope of scopes) {
			await collectRulesetsForScope(scope, token, meta);
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

// ---------------------------------------------------------------------------
// Cache rules analysis (ported from cf-cache-analyzer)

app.post("/api/cache/analyze", async (c) => {
	const token = getAuthToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ success: false, errors: [{ message: "Authorization token is missing or invalid" }] }, 401);
	}
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

// Static assets fallback
app.all("*", async (c) => {
	const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
	if (assetResponse.status === 404) {
		return new Response("Not Found", { status: 404 });
	}
	return assetResponse;
});

export default app;

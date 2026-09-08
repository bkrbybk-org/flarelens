import { Hono } from "hono";
import { assertAllowedScope, resolveAuth, type AuthEnv } from "./lib/auth";
import { TunnelMapError, fetchTunnelMap } from "./lib/access-tunnels";
import { PqcError, fetchPqcReport, type PqcZone } from "./lib/pqc";
import { emptyAdoption, fetchAdoption, probeAdoptionDimension, unavailableReason } from "./lib/pqc-adoption";
import { RequestTraceError, normaliseRayId, traceRequest } from "./lib/request-trace";
import { MAX_AI_RANGE_MS, WorkersAiError, fetchWorkersAi, isAiGranularity } from "./lib/workers-ai";
import {
	MAX_AI_GATEWAY_RANGE_MS,
	AiGatewayUsageError,
	fetchAiGatewayUsage,
	isAiGatewayGranularity,
} from "./lib/ai-gateway";
import {
	MAX_GATEWAY_RANGE_MS,
	GatewayUsageError,
	fetchGatewayUsage,
	isGatewayGranularity,
} from "./lib/gateway-usage";
import {
	MAX_ACCESS_RANGE_MS,
	AccessUsageError,
	fetchAccessUsage,
	isAccessGranularity,
} from "./lib/access-usage";
import {
	MAX_RANGE_MS,
	WorkersAnalyticsError,
	fetchWorkerMetrics,
	isGranularity,
	listWorkerScripts,
	parseInstant,
} from "./lib/workers-analytics";
import { collectRulesetsForScope, UpstreamError, type RuleMetaMap, type RulesetScope } from "./lib/waf-meta";
import { loadAiSecurity, type AiSecRequest } from "./lib/ai-sec";
import { CfApiError } from "./lib/ai-sec/cf/types";
import {
	ALLOWED_RANGES,
	assembleAnalytics,
	computeInsights,
	fetchRuleShells,
	fetchVersioning,
	fetchZoneName,
	type CacheCredentials,
} from "./lib/cache-analysis";

interface Env extends AuthEnv {
	ASSETS: Fetcher;
	/** Populated by the version_metadata binding; absent under `wrangler dev` without it. */
	CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
	/**
	 * "0" lets AI Security run under the bound token like every other section. Default is the
	 * restrictive one: that section's rows carry client IPs and encrypted request payloads, and
	 * reading them under a shared credential collapses the Cloudflare audit trail to one identity.
	 */
	AI_REQUIRES_BYOT?: string;
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

// Mirrors web/src/types.ts's CfGroup rather than importing it: the Worker and the SPA each
// declare their own shape for every Cloudflare type in this codebase (see CfIdp/CfPolicy/CfApp
// above), so a reader looking at either side alone sees the real shape without having to
// cross-reference the other package. This one under-declared its fields for a while — the
// endpoint below passes the full upstream group object straight through, so the client's
// richer type was always the accurate one.
interface CfGroup {
	id: string;
	name?: string;
	include?: unknown[];
	exclude?: unknown[];
	require?: unknown[];
	created_at?: string;
	updated_at?: string;
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

interface CfAccount {
	id: string;
	name?: string;
}

/** Accounts on the deployment allowlist, mapped down to what the client actually needs. */
function filterAllowedAccounts(accounts: CfAccount[], env: Env): { id: string; name: string }[] {
	const allowed = new Set(
		(env.ALLOWED_ACCOUNT_IDS || "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter(Boolean),
	);
	return accounts
		.filter((account) => allowed.has(account.id.toLowerCase()))
		.map((account) => ({ id: account.id, name: account.name || account.id }));
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

/** Accounts the caller may use. In server mode the deployment allowlist narrows the list. */
app.get("/api/accounts", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const token = auth.auth.token;
	const { status, data } = await fetchCloudflare<CfAccount>("/accounts", token);
	if (status !== 200 || !data.success || auth.auth.mode !== "server") {
		return c.json(data, status as 200);
	}
	// Offering an account the allowlist would refuse just produces a 403 one click later.
	return c.json({ ...data, result: filterAllowedAccounts(data.result || [], c.env) });
});

/**
 * Bootstrap for the SPA: which credential model is in play, and which accounts are on offer.
 *
 * Deliberately returns `byot` rather than 401 when the Access gate does not pass, so an
 * unauthenticated caller learns nothing about whether this deployment binds a token. The token
 * itself is never part of the response — only the mode and the account list it can reach.
 */
app.get("/api/config", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	const version = c.env.CF_VERSION_METADATA
		? { id: c.env.CF_VERSION_METADATA.id, tag: c.env.CF_VERSION_METADATA.tag, timestamp: c.env.CF_VERSION_METADATA.timestamp }
		: undefined;

	if (!auth.ok || auth.auth.mode !== "server") {
		return c.json({ success: true, result: { mode: "byot", version } });
	}

	const { status, data } = await fetchCloudflare<CfAccount>("/accounts", auth.auth.token);
	if (status !== 200 || !data.success) {
		return c.json({
			success: true,
			result: { mode: "server", accounts: [], accountsError: "Failed to list accounts for the configured token", version },
		});
	}

	return c.json({
		success: true,
		result: { mode: "server", accounts: filterAllowedAccounts(data.result || [], c.env), version },
	});
});

app.get("/api/zones", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const token = auth.auth.token;
	const accountId = c.req.query("account_id");
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
	}
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}
	const res = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
	if (res.status !== 200) {
		return c.json({ success: false, errors: res.errors || [{ message: "Failed to fetch zones" }] }, res.status as 200);
	}
	return c.json({ success: true, result: res.result.map((z) => ({ id: z.id, name: z.name })) });
});

app.get("/api/data", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const token = auth.auth.token;
	const accountId = c.req.query("account_id");
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
	}
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
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
	// read scopes still get the core app/policy view. Surface the failure so
	// the connect screen can report the scope as missing rather than "empty".
	const groups = groupsRes.status === 200 ? groupsRes.result : [];
	const groupsError = groupsRes.status !== 200;
	const reusablePolicies = reusableRes.status === 200 ? reusableRes.result : [];
	const reusablePoliciesError = reusableRes.status !== 200;

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
			groups_error: groupsError,
			reusable_policies: reusablePolicies,
			reusable_policies_error: reusablePoliciesError,
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

// ---------------------------------------------------------------------------
// Zero Trust Gateway usage (DNS resolver + Gateway HTTP)

app.post("/api/gateway/usage", async (c) => {
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
	if (Date.parse(until) - Date.parse(since) > MAX_GATEWAY_RANGE_MS) {
		return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
	}
	const granularity = isGatewayGranularity(body.granularity) ? body.granularity : "hourly";
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		const result = await fetchGatewayUsage(accountId, auth.auth.token, { since, until, granularity });
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof GatewayUsageError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to load Gateway usage";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// Workers AI (inference volume, neurons, tokens, models)

app.post("/api/workers-ai/usage", async (c) => {
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
	if (Date.parse(until) - Date.parse(since) > MAX_AI_RANGE_MS) {
		return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
	}
	const granularity = isAiGranularity(body.granularity) ? body.granularity : "hourly";
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		const result = await fetchWorkersAi(accountId, auth.auth.token, { since, until, granularity });
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof WorkersAiError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to load Workers AI usage";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// AI Gateway (request volume, tokens, spend, errors, cache — see src/lib/ai-gateway.ts for the
// unverified-field-name caveat: this has never been run against a real account)

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

// ---------------------------------------------------------------------------
// Per-request forensics by Ray ID

app.post("/api/request/trace", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	let body: { accountId?: string; rayId?: string; zoneId?: string; minutes?: number };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, errors: [{ message: "Request body must be valid JSON" }] }, 400);
	}
	const accountId = validHexId(body.accountId);
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Invalid accountId" }] }, 400);
	}
	const rayId = normaliseRayId(body.rayId);
	if (!rayId) {
		return c.json({ success: false, errors: [{ message: "Ray ID must be 16 hexadecimal characters" }] }, 400);
	}
	const zoneId = body.zoneId ? validHexId(body.zoneId) : null;
	if (body.zoneId && !zoneId) {
		return c.json({ success: false, errors: [{ message: "Invalid zoneId" }] }, 400);
	}
	// Cloudflare keeps this data for a bounded period; 30 days is the widest any section offers.
	const requested = Number(body.minutes);
	const minutes = Math.min(43_200, Math.max(30, Number.isFinite(requested) ? requested : 1440));
	const scope = assertAllowedScope(auth.auth, c.env, { accountId, zoneId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		const result = await traceRequest(
			auth.auth.token,
			{ accountId, rayId, zoneId: zoneId || undefined, minutes },
			(p) => c.executionCtx.waitUntil(p),
		);
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof RequestTraceError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to trace the request";
		return c.json({ success: false, errors: [{ message }] }, status === 401 || status === 403 ? status : (status as 502));
	}
});

// ---------------------------------------------------------------------------
// Access application → Tunnel → origin mapping

/**
 * Joins Access applications to the tunnel ingress rules that serve their hostnames.
 *
 * Apps are fetched here rather than taken from the client so the join cannot be skewed by a
 * stale page: the mapping is only meaningful if both halves come from the same moment.
 */
app.get("/api/access/tunnels", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const accountId = validHexId(c.req.query("account_id"));
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
	}
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	const token = auth.auth.token;
	const [appsRes, policiesRes] = await Promise.all([
		fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, token),
		fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/policies`, token),
	]);
	if (appsRes.status !== 200) {
		return c.json(
			{ success: false, errors: appsRes.errors || [{ message: "Failed to fetch applications" }] },
			appsRes.status as 200,
		);
	}

	// Per-app policies, same bounded fan-out as /api/data. Reusable policies are resolved from
	// the account list so a policy attached by reference still shows its name and decision.
	const reusable = new Map((policiesRes.status === 200 ? policiesRes.result : []).map((p) => [p.id, p]));
	const withPolicies = await mapWithConcurrency(appsRes.result, 5, async (appItem) => {
		const res = await fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/apps/${appItem.id}/policies`, token);
		const policies = (res.status === 200 ? res.result : []).map((p) => {
			const hasRules = Array.isArray(p.include) || Array.isArray(p.exclude) || Array.isArray(p.require);
			const source = !hasRules && reusable.has(p.id) ? { ...reusable.get(p.id), ...p } : p;
			return { name: source.name, decision: source.decision };
		});
		return { ...appItem, policies, policies_error: res.status !== 200 };
	});

	try {
		const result = await fetchTunnelMap(accountId, token, withPolicies);
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof TunnelMapError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to build the tunnel map";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// PQC readiness (post-quantum coverage per hostname)

/**
 * Window for measured adoption: the last 24 hours.
 *
 * Fixed rather than driven by the shared range picker, because this section is a configuration
 * inventory and does not otherwise carry a time range. A day is long enough to average over a
 * traffic cycle and short enough to reflect a client population that is changing month by month.
 * Both bounds go through toISOString(), the same injection boundary every other route uses.
 */
function adoptionWindow(): { since: string; until: string } {
	const until = new Date();
	const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
	return { since: since.toISOString(), until: until.toISOString() };
}

/**
 * Post-quantum readiness for every proxiable hostname in the account.
 *
 * Zone-wide by design: the settings that decide the answer (TLS 1.3, SSL mode) are zone settings,
 * and the inventory question being asked is "which of our names are not covered", which cannot be
 * answered one zone at a time. `zone_id` narrows it when an operator wants a single zone.
 *
 * Needs Zone: DNS: Read for the record inventory. Without it each zone comes back carrying its
 * own error and no rows, rather than the page reporting an empty, clean-looking account.
 */
app.get("/api/pqc/report", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const accountId = validHexId(c.req.query("account_id"));
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
	}
	const zoneParam = c.req.query("zone_id");
	const zoneId = zoneParam ? validHexId(zoneParam) : null;
	if (zoneParam && !zoneId) {
		return c.json({ success: false, errors: [{ message: "Invalid zone_id" }] }, 400);
	}
	const scope = assertAllowedScope(auth.auth, c.env, zoneId ? { accountId, zoneId } : { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	const token = auth.auth.token;
	const zonesRes = await fetchCloudflareAll<CfZone>(`/zones?account.id=${encodeURIComponent(accountId)}`, token);
	if (zonesRes.status !== 200) {
		return c.json({ success: false, errors: zonesRes.errors || [{ message: "Failed to fetch zones" }] }, zonesRes.status as 200);
	}

	const zones: PqcZone[] = zonesRes.result
		.filter((z) => !zoneId || z.id === zoneId)
		.map((z) => ({ id: z.id, name: z.name || z.id }));

	try {
		const report = await fetchPqcReport(accountId, token, zones);

		// Measured adoption is a capability question, not a given: the key-exchange dimension may
		// not exist in this account's schema at all. Probe, then either measure or say why not —
		// never report 0% for a question the schema cannot answer. See lib/pqc-adoption.ts.
		const probe = await probeAdoptionDimension(token);
		let adoption = probe.dimension
			? await fetchAdoption(token, zones, adoptionWindow(), probe.dimension)
			: emptyAdoption(probe.error ?? unavailableReason(probe.candidates), probe.candidates);
		if (probe.dimension && adoption.errors.length === zones.length && zones.length > 0) {
			// Every zone failed: the dimension introspects but cannot actually be queried, which
			// is a different failure from it being absent and is worth saying so.
			adoption = emptyAdoption(`The ${probe.dimension} dimension exists but no zone could be queried: ${adoption.errors[0].message}`, probe.candidates);
		}

		return c.json({ success: true, result: { ...report, adoption } });
	} catch (err) {
		const status = err instanceof PqcError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to build the PQC report";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// Access usage (login telemetry for Access-protected apps)

/**
 * Login volume, success/failure split and top apps, identity providers and countries.
 *
 * Deliberately aggregate-only: the dataset can break logins down per user identity, and this
 * endpoint does not ask for that. Everything here answers "is Access working and who is it
 * serving" without the response becoming a per-person access log.
 */
app.post("/api/access/usage", async (c) => {
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
	// Same instant parser as the Workers section: both bounds land in a GraphQL document.
	const since = parseInstant(body.from);
	const until = parseInstant(body.to);
	if (!since || !until) {
		return c.json({ success: false, errors: [{ message: "from and to must be ISO-8601 UTC instants" }] }, 400);
	}
	if (Date.parse(until) <= Date.parse(since)) {
		return c.json({ success: false, errors: [{ message: "to must be later than from" }] }, 400);
	}
	if (Date.parse(until) - Date.parse(since) > MAX_ACCESS_RANGE_MS) {
		// Cloudflare refuses anything wider than 1w on this dataset.
		return c.json({ success: false, errors: [{ message: "Access usage supports a range of at most 7 days" }] }, 400);
	}
	const granularity = isAccessGranularity(body.granularity) ? body.granularity : "hourly";
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		// Names are best-effort enrichment: a token without the Access read scopes still gets
		// the usage numbers, just labelled by uuid.
		const [appsRes, idpsRes] = await Promise.all([
			fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, auth.auth.token),
			fetchCloudflareAll<CfIdp>(`/accounts/${accountId}/access/identity_providers`, auth.auth.token),
		]);
		const appNames = Object.fromEntries(
			(appsRes.status === 200 ? appsRes.result : []).map((a) => [a.id, a.name || a.id]),
		);
		const idpNames = Object.fromEntries(
			(idpsRes.status === 200 ? idpsRes.result : []).map((i) => [i.id, i.name || i.id]),
		);

		const result = await fetchAccessUsage(accountId, auth.auth.token, {
			since,
			until,
			granularity,
			appNames,
			idpNames,
		});
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof AccessUsageError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to load Access usage";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// Workers analytics (per-script requests, errors, subrequests, CPU time)

/** Script names on the account, for the Workers section's per-worker filter. */
app.get("/api/workers/scripts", async (c) => {
	const auth = await resolveAuth(c.req.raw, c.env);
	if (!auth.ok) {
		return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
	}
	const accountId = validHexId(c.req.query("account_id"));
	if (!accountId) {
		return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
	}
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		return c.json({ success: true, result: await listWorkerScripts(accountId, auth.auth.token) });
	} catch (err) {
		const status = err instanceof WorkersAnalyticsError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to list Workers scripts";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

/**
 * Per-script invocation metrics for a window.
 *
 * Both bounds are required and must be full UTC instants: they are interpolated into a GraphQL
 * document, so the parse is the boundary that keeps caller text out of the query.
 */
app.post("/api/workers/metrics", async (c) => {
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
	if (Date.parse(until) - Date.parse(since) > MAX_RANGE_MS) {
		return c.json({ success: false, errors: [{ message: "Range is longer than the supported 30 days" }] }, 400);
	}
	const granularity = isGranularity(body.granularity) ? body.granularity : "hourly";
	const scope = assertAllowedScope(auth.auth, c.env, { accountId });
	if (scope) {
		return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
	}

	try {
		const result = await fetchWorkerMetrics(accountId, auth.auth.token, { since, until, granularity });
		return c.json({ success: true, result });
	} catch (err) {
		const status = err instanceof WorkersAnalyticsError ? err.status : 502;
		const message = err instanceof Error ? err.message : "Failed to load Workers metrics";
		return c.json({ success: false, errors: [{ message }] }, status as 502);
	}
});

// ---------------------------------------------------------------------------
// Cache rules analysis (ported from cf-cache-analyzer)

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

// Static assets fallback
app.all("*", async (c) => {
	const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
	if (assetResponse.status === 404) {
		return new Response("Not Found", { status: 404 });
	}
	return assetResponse;
});

export default app;

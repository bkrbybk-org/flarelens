import { Hono } from "hono";

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
	} catch (e) {
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

// Static assets fallback
app.all("*", async (c) => {
	const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
	if (assetResponse.status === 404) {
		return new Response("Not Found", { status: 404 });
	}
	return assetResponse;
});

export default app;

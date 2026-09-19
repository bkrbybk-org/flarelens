import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from "jose";
import app from "../src/index";
import { resetJwksCache } from "../src/lib/auth";
import { ctx } from "./helpers/execution-context";

/**
 * Route-level cover for the auth retrofit. The unit tests prove resolveAuth itself; these prove
 * every route is actually wired to it, and that server mode cannot reach an account the
 * deployment has not allowlisted.
 */

const TEAM_DOMAIN = "example.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
const ALLOWED_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ACCOUNT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZONE = "cccccccccccccccccccccccccccccccc";

const BYOT_ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };

const SERVER_ENV = {
	...BYOT_ENV,
	CF_API_TOKEN: "server-side-secret",
	CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
	CF_ACCESS_AUD: AUD,
	ALLOWED_ACCOUNT_IDS: ALLOWED_ACCOUNT,
	ALLOWED_ZONE_IDS: ZONE,
};

let signingKey: KeyObject | CryptoKey;
/** Authorization headers seen by the mocked Cloudflare API, so we can assert which token went out. */
let upstreamAuth: string[] = [];

function makeJwt(): Promise<string> {
	return new SignJWT({ email: "operator@example.com" })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuedAt()
		.setIssuer(`https://${TEAM_DOMAIN}`)
		.setAudience(AUD)
		.setExpirationTime("5m")
		.sign(signingKey);
}

beforeEach(async () => {
	resetJwksCache();
	upstreamAuth = [];
	const pair = await generateKeyPair("RS256");
	signingKey = pair.privateKey;
	const jwk = await exportJWK(pair.publicKey);

	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
			return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		const headers = new Headers(init?.headers);
		upstreamAuth.push(headers.get("Authorization") || "");
		const result = url.includes("/accounts")
			? [
				{ id: ALLOWED_ACCOUNT, name: "Allowed Account" },
				{ id: OTHER_ACCOUNT, name: "Some Other Account" },
			]
			: [];
		return new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const GATED_ROUTES: { name: string; path: string; init?: RequestInit }[] = [
	{ name: "GET /api/accounts", path: "/api/accounts" },
	{ name: "GET /api/zones", path: `/api/zones?account_id=${ALLOWED_ACCOUNT}` },
	{ name: "GET /api/data", path: `/api/data?account_id=${ALLOWED_ACCOUNT}` },
	{ name: "GET /api/waf/rulesets", path: `/api/waf/rulesets?account_id=${ALLOWED_ACCOUNT}` },
	{ name: "GET /api/bots/report", path: `/api/bots/report?account_id=${ALLOWED_ACCOUNT}` },
	{
		name: "POST /api/waf/events",
		path: "/api/waf/events",
		init: { method: "POST", body: JSON.stringify({ accountId: ALLOWED_ACCOUNT }) },
	},
	{
		name: "POST /api/cache/analyze",
		path: "/api/cache/analyze",
		init: { method: "POST", body: JSON.stringify({ zoneId: ZONE }) },
	},
	{
		name: "POST /api/ai-security/analyze",
		path: "/api/ai-security/analyze",
		init: { method: "POST", body: JSON.stringify({ accountId: ALLOWED_ACCOUNT }) },
	},
];

describe("every /api route is gated", () => {
	it.each(GATED_ROUTES)("$name refuses an unauthenticated request", async ({ path, init }) => {
		const res = await app.request(path, init, BYOT_ENV);
		expect(res.status).toBe(401);
	});

	it.each(GATED_ROUTES)("$name refuses a bare Access email header", async ({ path, init }) => {
		// The header is trivially forgeable; only a verified JWT counts.
		const res = await app.request(
			path,
			{ ...init, headers: { "Cf-Access-Authenticated-User-Email": "operator@example.com" } },
			SERVER_ENV,
		);
		expect(res.status).toBe(401);
	});
});

/**
 * Every account- or zone-scoped route, with a request that passes input validation — so the only
 * thing standing between it and the upstream API is the allowlist. A request that failed
 * validation would come back 400 and prove nothing about the scope check, which is why the
 * control case below asserts the allowlisted request gets past the gate.
 */
const now = new Date();
const RANGE = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: now.toISOString() };
const post = (body: Record<string, unknown>): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
const OTHER_ZONE = "dddddddddddddddddddddddddddddddd";

const SCOPED_ROUTES: { name: string; request: (account: string, zone: string) => { path: string; init?: RequestInit } }[] = [
	{ name: "GET /api/zones", request: (a) => ({ path: `/api/zones?account_id=${a}` }) },
	{ name: "GET /api/data", request: (a) => ({ path: `/api/data?account_id=${a}` }) },
	{ name: "GET /api/waf/rulesets", request: (a) => ({ path: `/api/waf/rulesets?account_id=${a}` }) },
	{ name: "GET /api/access/tunnels", request: (a) => ({ path: `/api/access/tunnels?account_id=${a}` }) },
	{ name: "GET /api/tunnels/:tunnelId/metrics", request: (a) => ({ path: `/api/tunnels/11111111-1111-1111-1111-111111111111/metrics?account_id=${a}` }) },
	{ name: "GET /api/pqc/report", request: (a) => ({ path: `/api/pqc/report?account_id=${a}` }) },
	{ name: "GET /api/zone-health/report", request: (a) => ({ path: `/api/zone-health/report?account_id=${a}` }) },
	{ name: "GET /api/gateway/policies", request: (a) => ({ path: `/api/gateway/policies?account_id=${a}` }) },
	{ name: "GET /api/shields/report", request: (a) => ({ path: `/api/shields/report?account_id=${a}` }) },
	{ name: "GET /api/dns/records", request: (a) => ({ path: `/api/dns/records?account_id=${a}` }) },
	{ name: "GET /api/bots/report", request: (a) => ({ path: `/api/bots/report?account_id=${a}` }) },
	{ name: "GET /api/workers/scripts", request: (a) => ({ path: `/api/workers/scripts?account_id=${a}` }) },
	{ name: "POST /api/waf/events", request: (a) => ({ path: "/api/waf/events", init: post({ accountId: a }) }) },
	{ name: "POST /api/access/usage", request: (a) => ({ path: "/api/access/usage", init: post({ accountId: a, ...RANGE }) }) },
	{ name: "POST /api/gateway/usage", request: (a) => ({ path: "/api/gateway/usage", init: post({ accountId: a, ...RANGE }) }) },
	{ name: "POST /api/workers/metrics", request: (a) => ({ path: "/api/workers/metrics", init: post({ accountId: a, ...RANGE }) }) },
	{ name: "POST /api/workers-ai/usage", request: (a) => ({ path: "/api/workers-ai/usage", init: post({ accountId: a, ...RANGE }) }) },
	{ name: "POST /api/ai-gateway/usage", request: (a) => ({ path: "/api/ai-gateway/usage", init: post({ accountId: a, ...RANGE }) }) },
	{ name: "POST /api/request/trace", request: (a) => ({ path: "/api/request/trace", init: post({ accountId: a, rayId: "8c1f2a3b4c5d6e7f" }) }) },
	{ name: "POST /api/cache/analyze", request: (_a, z) => ({ path: "/api/cache/analyze", init: post({ zoneId: z }) }) },
];

describe("server mode cannot reach a scope the deployment has not allowlisted", () => {
	// Only 5 of these routes had this pinned before. The rest relied on the scope check being
	// present in the handler with nothing to notice if it went — and since some routes now cache
	// their responses, a missing check would also write another account's data into the cache.
	let cacheCalls: string[] = [];
	beforeEach(() => {
		cacheCalls = [];
		(globalThis as { caches?: unknown }).caches = {
			default: {
				match: async (key: string) => { cacheCalls.push(`match ${key}`); return undefined; },
				put: async (key: string) => { cacheCalls.push(`put ${key}`); },
			},
		};
	});

	it.each(SCOPED_ROUTES)("$name refuses it before calling upstream or touching the cache", async ({ request }) => {
		const jwt = await makeJwt();
		const { path, init } = request(OTHER_ACCOUNT, OTHER_ZONE);
		const headers = { ...((init?.headers as Record<string, string>) || {}), "Cf-Access-Jwt-Assertion": jwt };
		const res = await app.request(path, { ...init, headers }, SERVER_ENV, ctx());

		expect(res.status).toBe(403);
		expect(upstreamAuth).toEqual([]);
		expect(cacheCalls).toEqual([]);
	});

	it.each(SCOPED_ROUTES)("$name lets the allowlisted scope through, so the refusal above is the allowlist's doing", async ({ request }) => {
		const jwt = await makeJwt();
		const { path, init } = request(ALLOWED_ACCOUNT, ZONE);
		const headers = { ...((init?.headers as Record<string, string>) || {}), "Cf-Access-Jwt-Assertion": jwt };
		const res = await app.request(path, { ...init, headers }, SERVER_ENV, ctx());

		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
		expect(res.status).not.toBe(400);
	});
});

describe("byot mode", () => {
	it("forwards the caller's own token upstream", async () => {
		const res = await app.request("/api/accounts", { headers: { Authorization: "Bearer caller-token" } }, BYOT_ENV);
		expect(res.status).toBe(200);
		expect(upstreamAuth).toContain("Bearer caller-token");
	});

	it("does not apply the deployment allowlist to a caller's own token", async () => {
		const res = await app.request(
			`/api/zones?account_id=${OTHER_ACCOUNT}`,
			{ headers: { Authorization: "Bearer caller-token" } },
			SERVER_ENV,
		);
		expect(res.status).toBe(200);
	});
});

describe("server mode", () => {
	it("serves an allowlisted account under the bound token after a valid Access JWT", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${ALLOWED_ACCOUNT}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
		);
		expect(res.status).toBe(200);
		expect(upstreamAuth).toContain("Bearer server-side-secret");
		expect(upstreamAuth.every((h) => !h.includes("caller-token"))).toBe(true);
	});

	it("refuses an account outside the allowlist before calling Cloudflare", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${OTHER_ACCOUNT}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
		);
		expect(res.status).toBe(403);
		expect(upstreamAuth).toHaveLength(0);
	});

	it("refuses a zone outside the allowlist", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			"/api/cache/analyze",
			{
				method: "POST",
				headers: { "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" },
				body: JSON.stringify({ zoneId: OTHER_ACCOUNT }),
			},
			SERVER_ENV,
		);
		expect(res.status).toBe(403);
		expect(upstreamAuth).toHaveLength(0);
	});

	it("is off entirely when the Access gate is not configured", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${ALLOWED_ACCOUNT}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			{ ...BYOT_ENV, CF_API_TOKEN: "server-side-secret" },
		);
		expect(res.status).toBe(401);
		expect(upstreamAuth).toHaveLength(0);
	});
});

describe("GET /api/config", () => {
	it("reports byot and leaks nothing when the Access gate does not pass", async () => {
		const res = await app.request("/api/config", undefined, SERVER_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { mode: string; accounts?: unknown } };
		expect(body.result.mode).toBe("byot");
		expect(body.result.accounts).toBeUndefined();
	});

	it("reports byot on a deployment with no server mode at all", async () => {
		const res = await app.request("/api/config", undefined, BYOT_ENV);
		expect(((await res.json()) as { result: { mode: string } }).result.mode).toBe("byot");
	});

	it("reports server mode and the allowlisted accounts after a valid Access JWT", async () => {
		const jwt = await makeJwt();
		const res = await app.request("/api/config", { headers: { "Cf-Access-Jwt-Assertion": jwt } }, {
			...SERVER_ENV,
			// One allowlisted, one not: only the first may be offered.
			ALLOWED_ACCOUNT_IDS: ALLOWED_ACCOUNT,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { mode: string; accounts: { id: string }[] } };
		expect(body.result.mode).toBe("server");
		expect(body.result.accounts.map((a) => a.id)).toEqual([ALLOWED_ACCOUNT]);
	});

	it("never includes the bound token in the response", async () => {
		const jwt = await makeJwt();
		const res = await app.request("/api/config", { headers: { "Cf-Access-Jwt-Assertion": jwt } }, SERVER_ENV);
		expect(await res.text()).not.toContain("server-side-secret");
	});
});

describe("AI Security opts out of the shared credential", () => {
	it("refuses server mode by default, even with a valid Access JWT", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			"/api/ai-security/analyze",
			{
				method: "POST",
				headers: { "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" },
				body: JSON.stringify({ accountId: ALLOWED_ACCOUNT }),
			},
			SERVER_ENV,
		);
		expect(res.status).toBe(401);
		const payload = (await res.json()) as { errors: { message: string }[] };
		expect(payload.errors[0].message).toMatch(/your own Cloudflare API token/);
	});

	it("still accepts the caller's own token", async () => {
		const res = await app.request(
			"/api/ai-security/analyze",
			{
				method: "POST",
				headers: { Authorization: "Bearer caller-token", "Content-Type": "application/json" },
				body: JSON.stringify({ accountId: OTHER_ACCOUNT }),
			},
			BYOT_ENV,
		);
		// Past the auth gate: whatever happens next is the feature's own business, not a 401.
		expect(res.status).not.toBe(401);
	});
});

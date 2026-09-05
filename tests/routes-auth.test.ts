import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from "jose";
import app from "../src/index";
import { resetJwksCache } from "../src/lib/auth";

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

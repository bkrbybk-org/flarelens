import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from "jose";
import app from "../src/index";
import { assertAllowedScope, resetJwksCache } from "../src/lib/auth";

/**
 * Security cover for the boundaries that are not about "does a valid request work": credential
 * confinement, allowlist evasion, and what an authenticated-but-hostile caller can reach.
 *
 * The happy-path auth contract lives in auth.test.ts and routes-auth.test.ts; this file is the
 * adversarial half.
 */

const TEAM_DOMAIN = "example.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
const ALLOWED = "11111111111111111111111111111111";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZONE = "44444444444444444444444444444444";
const SECRET = "super-secret-bound-token";

const ASSETS = { fetch: async () => new Response("", { status: 404 }) };
const SERVER_ENV = {
	ASSETS,
	CF_API_TOKEN: SECRET,
	CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
	CF_ACCESS_AUD: AUD,
	ALLOWED_ACCOUNT_IDS: ALLOWED,
	ALLOWED_ZONE_IDS: ZONE,
};
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });

let signingKey: KeyObject | CryptoKey;
let upstreamUrls: string[] = [];

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
	upstreamUrls = [];
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
	const pair = await generateKeyPair("RS256");
	signingKey = pair.privateKey;
	const jwk = await exportJWK(pair.publicKey);
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
			return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		upstreamUrls.push(url);
		return new Response(JSON.stringify({ success: true, result: [], result_info: { total_pages: 1 } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe("the bound token never leaves the worker", () => {
	it("is absent from /api/config", async () => {
		const jwt = await makeJwt();
		const res = await app.request("/api/config", { headers: { "Cf-Access-Jwt-Assertion": jwt } }, SERVER_ENV, ctx());
		expect(await res.text()).not.toContain(SECRET);
	});

	it("is absent from an error response", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${OTHER}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
			ctx(),
		);
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain(SECRET);
	});

	it("is not echoed back when a caller supplies their own token", async () => {
		const res = await app.request("/api/accounts", { headers: { Authorization: "Bearer caller-token" } }, SERVER_ENV, ctx());
		const text = await res.text();
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("caller-token");
	});
});

describe("allowlist cannot be evaded", () => {
	const attempts: [string, string][] = [
		["uppercase", ALLOWED.toUpperCase().replace(ALLOWED.slice(0, 4).toUpperCase(), OTHER.slice(0, 4))],
		["a different account entirely", OTHER],
		["an allowlisted id with a suffix", `${ALLOWED}extra`],
		["an allowlisted id with a prefix", `x${ALLOWED}`],
	];

	it.each(attempts)("refuses %s and calls nothing upstream", async (_label, accountId) => {
		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${encodeURIComponent(accountId)}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
			ctx(),
		);
		expect(res.status).toBe(403);
		expect(upstreamUrls).toHaveLength(0);
	});

	it("refuses a zone outside the zone allowlist even on an allowed account", async () => {
		const jwt = await makeJwt();
		const res = await app.request(
			"/api/waf/rulesets?account_id=" + ALLOWED + "&zone_id=" + "f".repeat(32),
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
			ctx(),
		);
		expect(res.status).toBe(403);
		expect(upstreamUrls).toHaveLength(0);
	});

	it("does not let whitespace or empty entries in the allowlist widen it", () => {
		const env = { ALLOWED_ACCOUNT_IDS: " , ,, " };
		const denial = assertAllowedScope({ mode: "server", token: SECRET }, env, { accountId: ALLOWED });
		expect(denial?.status).toBe(403);
	});

	it("still applies the allowlist when only a zone is supplied", () => {
		const denial = assertAllowedScope({ mode: "server", token: SECRET }, { ALLOWED_ACCOUNT_IDS: ALLOWED }, { zoneId: ZONE });
		expect(denial?.status).toBe(403);
	});
});

describe("input handling", () => {
	it("rejects non-hex ids rather than forwarding them upstream", async () => {
		const res = await app.request(
			"/api/waf/rulesets?account_id=../../etc/passwd",
			{ headers: { Authorization: "Bearer caller-token" } },
			SERVER_ENV,
			ctx(),
		);
		expect(res.status).toBe(400);
		expect(upstreamUrls).toHaveLength(0);
	});

	it("url-encodes the account id it interpolates into an upstream path", async () => {
		await app.request(
			`/api/zones?account_id=${encodeURIComponent("abc def")}`,
			{ headers: { Authorization: "Bearer caller-token" } },
			SERVER_ENV,
			ctx(),
		);
		for (const url of upstreamUrls) expect(url).not.toContain(" ");
	});

	it("does not reflect caller input into the response body", async () => {
		const payload = "<script>alert(1)</script>";
		const res = await app.request(
			`/api/waf/rulesets?account_id=${encodeURIComponent(payload)}`,
			{ headers: { Authorization: "Bearer caller-token" } },
			SERVER_ENV,
			ctx(),
		);
		expect(await res.text()).not.toContain("<script>");
	});
});

describe("response hardening", () => {
	it("keeps API responses out of any cache", async () => {
		const res = await app.request("/api/accounts", { headers: { Authorization: "Bearer t" } }, SERVER_ENV, ctx());
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("forbids framing and inline script on every response", async () => {
		const res = await app.request("/health", undefined, SERVER_ENV, ctx());
		const csp = res.headers.get("Content-Security-Policy") || "";
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).not.toContain("unsafe-inline");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});

	it("does not disclose whether server mode exists to an unauthenticated caller", async () => {
		// /api/config answers "byot" rather than 401, so a scanner learns nothing about the
		// deployment's credential model.
		const res = await app.request("/api/config", undefined, SERVER_ENV, ctx());
		const body = (await res.json()) as { result: { mode: string; accounts?: unknown } };
		expect(body.result.mode).toBe("byot");
		expect(body.result.accounts).toBeUndefined();
	});
});

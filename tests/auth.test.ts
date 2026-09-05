import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import {
	assertAllowedScope,
	getBearerToken,
	resetJwksCache,
	resolveAuth,
	serverModeConfigured,
	type AuthEnv,
} from "../src/lib/auth";

const TEAM_DOMAIN = "example.cloudflareaccess.com";
const AUD = "aud-tag-under-test";

const ENV: AuthEnv = {
	CF_API_TOKEN: "server-side-secret",
	CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
	CF_ACCESS_AUD: AUD,
	ALLOWED_ACCOUNT_IDS: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

let signingKey: KeyObject | CryptoKey;
let attackerKey: KeyObject | CryptoKey;

// The JWKS endpoint jose fetches. Only the real keypair's public half is published, so a token
// signed by `attackerKey` cannot verify.
async function publishJwks(publicJwk: JWK) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
			return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
}

interface JwtOverrides {
	aud?: string;
	iss?: string;
	expiresIn?: string;
	key?: KeyObject | CryptoKey;
}

function makeJwt(overrides: JwtOverrides = {}): Promise<string> {
	return new SignJWT({ email: "operator@example.com" })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuedAt()
		.setIssuer(overrides.iss ?? `https://${TEAM_DOMAIN}`)
		.setAudience(overrides.aud ?? AUD)
		.setExpirationTime(overrides.expiresIn ?? "5m")
		.sign(overrides.key ?? signingKey);
}

function request(headers: Record<string, string> = {}): Request {
	return new Request("https://flarelens.example.org/api/data?account_id=x", { headers });
}

beforeEach(async () => {
	resetJwksCache();
	const pair = await generateKeyPair("RS256");
	const attackerPair = await generateKeyPair("RS256");
	signingKey = pair.privateKey;
	attackerKey = attackerPair.privateKey;
	await publishJwks(await exportJWK(pair.publicKey));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getBearerToken", () => {
	it("extracts and trims a Bearer token", () => {
		expect(getBearerToken("Bearer  abc ")).toBe("abc");
	});

	it("rejects other schemes, empty values and absence", () => {
		expect(getBearerToken("Basic abc")).toBeNull();
		expect(getBearerToken("Bearer   ")).toBeNull();
		expect(getBearerToken(undefined)).toBeNull();
	});
});

describe("serverModeConfigured", () => {
	it("requires the secret and both halves of the Access gate", () => {
		expect(serverModeConfigured(ENV)).toBe(true);
		expect(serverModeConfigured({ ...ENV, CF_API_TOKEN: undefined })).toBe(false);
		expect(serverModeConfigured({ ...ENV, CF_ACCESS_TEAM_DOMAIN: undefined })).toBe(false);
		expect(serverModeConfigured({ ...ENV, CF_ACCESS_AUD: undefined })).toBe(false);
	});
});

describe("resolveAuth — byot", () => {
	it("uses the caller's token when a Bearer header is present", async () => {
		const result = await resolveAuth(request({ Authorization: "Bearer caller-token" }), ENV);
		expect(result).toEqual({ ok: true, auth: { mode: "byot", token: "caller-token" } });
	});

	it("prefers the Bearer header over the bound secret, without touching the JWKS", async () => {
		const jwt = await makeJwt();
		const result = await resolveAuth(
			request({ Authorization: "Bearer caller-token", "Cf-Access-Jwt-Assertion": jwt }),
			ENV,
		);
		expect(result).toEqual({ ok: true, auth: { mode: "byot", token: "caller-token" } });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("401s with no Bearer header on a deployment without server mode", async () => {
		const result = await resolveAuth(request(), { });
		expect(result).toEqual({ ok: false, status: 401, message: "Authorization token is missing or invalid" });
	});
});

describe("resolveAuth — server mode", () => {
	it("accepts a valid Access JWT and returns the bound token", async () => {
		const jwt = await makeJwt();
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV);
		expect(result).toEqual({
			ok: true,
			auth: { mode: "server", token: "server-side-secret", email: "operator@example.com" },
		});
	});

	it("accepts the JWT from the CF_Authorization cookie", async () => {
		const jwt = await makeJwt();
		const result = await resolveAuth(request({ Cookie: `other=1; CF_Authorization=${jwt}` }), ENV);
		expect(result.ok).toBe(true);
		expect(result.ok && result.auth.mode).toBe("server");
	});

	it("rejects a JWT for a different audience", async () => {
		const jwt = await makeJwt({ aud: "some-other-app" });
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV);
		expect(result).toEqual({ ok: false, status: 401, message: "Authorization token is missing or invalid" });
	});

	it("rejects a JWT from a different issuer", async () => {
		const jwt = await makeJwt({ iss: "https://attacker.cloudflareaccess.com" });
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV);
		expect(result.ok).toBe(false);
	});

	it("rejects an expired JWT", async () => {
		const jwt = await makeJwt({ expiresIn: "-1m" });
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV);
		expect(result.ok).toBe(false);
	});

	it("rejects a JWT signed by a key that is not in the JWKS", async () => {
		const jwt = await makeJwt({ key: attackerKey });
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV);
		expect(result.ok).toBe(false);
	});

	it("rejects a request with no JWT at all", async () => {
		const result = await resolveAuth(request(), ENV);
		expect(result.ok).toBe(false);
	});

	it("ignores Cf-Access-Authenticated-User-Email on its own", async () => {
		const result = await resolveAuth(request({ "Cf-Access-Authenticated-User-Email": "operator@example.com" }), ENV);
		expect(result.ok).toBe(false);
	});

	it("does not fall back to the secret when the gate is unconfigured", async () => {
		const jwt = await makeJwt();
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), { CF_API_TOKEN: "server-side-secret" });
		expect(result).toEqual({ ok: false, status: 401, message: "Authorization token is missing or invalid" });
	});

	it("refuses server mode on routes that opt out, even with a valid JWT", async () => {
		const jwt = await makeJwt();
		const result = await resolveAuth(request({ "Cf-Access-Jwt-Assertion": jwt }), ENV, { allowServerMode: false });
		expect(result).toEqual({
			ok: false,
			status: 401,
			message: "This section requires your own Cloudflare API token",
		});
	});

	it("still accepts a Bearer token on routes that opt out of server mode", async () => {
		const result = await resolveAuth(request({ Authorization: "Bearer caller-token" }), ENV, {
			allowServerMode: false,
		});
		expect(result).toEqual({ ok: true, auth: { mode: "byot", token: "caller-token" } });
	});
});

describe("assertAllowedScope", () => {
	const serverAuth = { mode: "server" as const, token: "server-side-secret" };
	const byotAuth = { mode: "byot" as const, token: "caller-token" };
	const allowedAccount = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const otherAccount = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("is a no-op in byot mode — Cloudflare bounds the caller's own token", () => {
		expect(assertAllowedScope(byotAuth, ENV, { accountId: otherAccount })).toBeNull();
	});

	it("allows an account on the allowlist", () => {
		expect(assertAllowedScope(serverAuth, ENV, { accountId: allowedAccount })).toBeNull();
	});

	it("is case-insensitive on ids", () => {
		expect(assertAllowedScope(serverAuth, ENV, { accountId: allowedAccount.toUpperCase() })).toBeNull();
	});

	it("rejects an account that is not on the allowlist", () => {
		expect(assertAllowedScope(serverAuth, ENV, { accountId: otherAccount })).toEqual({
			ok: false,
			status: 403,
			message: "Account is not available on this deployment",
		});
	});

	it("rejects every account when the allowlist is empty", () => {
		expect(assertAllowedScope(serverAuth, { ...ENV, ALLOWED_ACCOUNT_IDS: "" }, { accountId: allowedAccount })?.ok).toBe(
			false,
		);
	});

	it("allows a zone on the zone allowlist", () => {
		const env = { ...ENV, ALLOWED_ZONE_IDS: "cccccccccccccccccccccccccccccccc" };
		expect(assertAllowedScope(serverAuth, env, { zoneId: "cccccccccccccccccccccccccccccccc" })).toBeNull();
	});

	it("rejects a zone that is not on a non-empty zone allowlist", () => {
		const env = { ...ENV, ALLOWED_ZONE_IDS: "cccccccccccccccccccccccccccccccc" };
		expect(assertAllowedScope(serverAuth, env, { accountId: allowedAccount, zoneId: otherAccount })?.status).toBe(403);
	});

	it("rejects a zone-only request when no zone allowlist is configured", () => {
		// /api/cache/analyze carries no account id, so an empty zone allowlist would leave it open.
		expect(assertAllowedScope(serverAuth, ENV, { zoneId: "cccccccccccccccccccccccccccccccc" })?.status).toBe(403);
	});
});

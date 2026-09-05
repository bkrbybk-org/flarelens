import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Credential resolution for every /api/* route.
 *
 * Two modes, decided per request at one choke point:
 *
 *   byot   — the caller supplied `Authorization: Bearer <cf token>`. This is the original
 *            model: the Cloudflare token IS the authentication, Cloudflare enforces its own
 *            scope, and the audit trail names the real operator.
 *   server — no Bearer header, and this deployment binds CF_API_TOKEN. The worker acts with
 *            its own credential, so the request MUST first prove it came through Cloudflare
 *            Access. Without that proof the deployment is an unauthenticated proxy to the
 *            bound account for anyone who can resolve the hostname.
 *
 * A Bearer header always wins, so server mode can never silently upgrade a caller's own
 * (possibly weaker) token to the bound one.
 */

export interface AuthEnv {
	/** Read-only Cloudflare API token. `wrangler secret put` only — never `vars`. */
	CF_API_TOKEN?: string;
	/** e.g. "your-team.cloudflareaccess.com". Issuer and JWKS host for Access JWTs. */
	CF_ACCESS_TEAM_DOMAIN?: string;
	/** AUD tag of the Access application protecting this hostname. */
	CF_ACCESS_AUD?: string;
	/** Comma-separated account ids server mode may touch. Empty = server mode reaches nothing. */
	ALLOWED_ACCOUNT_IDS?: string;
	/** Comma-separated zone ids. Empty = any zone under an allowed account. */
	ALLOWED_ZONE_IDS?: string;
}

export type AuthMode = "byot" | "server";

export interface Auth {
	mode: AuthMode;
	/** The Cloudflare API token to use upstream. Never send this to the client. */
	token: string;
	/** Access identity, server mode only. Display and app-side audit logging only. */
	email?: string;
}

/** A refusal, carrying the status and message the route should return verbatim. */
export interface AuthDenial {
	ok: false;
	status: 401 | 403;
	message: string;
}

export type AuthResult = { ok: true; auth: Auth } | AuthDenial;

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE = "CF_Authorization";

/** JWKS fetchers are cached per team domain; jose handles key rotation and its own TTL. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

/** Exposed for tests, which need a clean JWKS per generated keypair. */
export function resetJwksCache(): void {
	jwksCache.clear();
}

/** Server mode is off unless the token AND both halves of the Access gate are configured. */
export function serverModeConfigured(env: AuthEnv): boolean {
	return Boolean(env.CF_API_TOKEN && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

export function getBearerToken(authorization: string | null | undefined): string | null {
	if (!authorization || !authorization.startsWith("Bearer ")) {
		return null;
	}
	const token = authorization.substring(7).trim();
	return token || null;
}

function readAccessJwt(req: Request): string | null {
	const header = req.headers.get(ACCESS_JWT_HEADER);
	if (header) {
		return header.trim() || null;
	}
	// Browsers navigating to the app carry the Access session as a cookie rather than a header.
	const cookie = req.headers.get("Cookie");
	if (!cookie) {
		return null;
	}
	for (const part of cookie.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === ACCESS_COOKIE) {
			return part.slice(eq + 1).trim() || null;
		}
	}
	return null;
}

/**
 * Verify a Cloudflare Access JWT against the team's JWKS.
 *
 * Signature, issuer, audience and expiry are all checked. Cf-Access-Authenticated-User-Email is
 * deliberately ignored: it is a plain header and carries no proof on its own.
 */
export async function verifyAccessJwt(req: Request, env: AuthEnv): Promise<JWTPayload | null> {
	const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
	const aud = env.CF_ACCESS_AUD;
	if (!teamDomain || !aud) {
		return null;
	}
	const jwt = readAccessJwt(req);
	if (!jwt) {
		return null;
	}
	try {
		const { payload } = await jwtVerify(jwt, jwksFor(teamDomain), {
			issuer: `https://${teamDomain}`,
			audience: aud,
		});
		return payload;
	} catch {
		// Any failure — bad signature, wrong aud, expired, unreachable JWKS — is a denial.
		// The reason is deliberately not echoed to the caller.
		return null;
	}
}

export interface ResolveOptions {
	/**
	 * Set false on routes whose data is too sensitive to read under a shared credential, so the
	 * Cloudflare audit trail names a real operator. Those routes require a Bearer token even on
	 * a deployment where server mode is otherwise enabled.
	 */
	allowServerMode?: boolean;
}

export async function resolveAuth(req: Request, env: AuthEnv, options: ResolveOptions = {}): Promise<AuthResult> {
	const { allowServerMode = true } = options;

	const bearer = getBearerToken(req.headers.get("Authorization"));
	if (bearer) {
		return { ok: true, auth: { mode: "byot", token: bearer } };
	}

	if (!allowServerMode) {
		return { ok: false, status: 401, message: "This section requires your own Cloudflare API token" };
	}
	if (!serverModeConfigured(env)) {
		return { ok: false, status: 401, message: "Authorization token is missing or invalid" };
	}

	const payload = await verifyAccessJwt(req, env);
	if (!payload) {
		return { ok: false, status: 401, message: "Authorization token is missing or invalid" };
	}

	return {
		ok: true,
		auth: {
			mode: "server",
			token: env.CF_API_TOKEN as string,
			email: typeof payload.email === "string" ? payload.email : undefined,
		},
	};
}

function parseIdList(raw: string | undefined): string[] {
	return (raw || "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

export interface RequestedScope {
	accountId?: string | null;
	zoneId?: string | null;
}

/**
 * In server mode the account/zone ids still arrive from the client, but there is no per-user
 * credential to bound them: whatever the bound token can reach, any caller could ask for. Check
 * them against the deploy-time allowlist before any upstream call.
 *
 * In byot mode this is a no-op — Cloudflare enforces the caller's own token scope.
 */
export function assertAllowedScope(auth: Auth, env: AuthEnv, scope: RequestedScope): AuthDenial | null {
	if (auth.mode !== "server") {
		return null;
	}

	const accounts = parseIdList(env.ALLOWED_ACCOUNT_IDS);
	if (scope.accountId) {
		if (accounts.length === 0 || !accounts.includes(scope.accountId.toLowerCase())) {
			return { ok: false, status: 403, message: "Account is not available on this deployment" };
		}
	}

	const zones = parseIdList(env.ALLOWED_ZONE_IDS);
	if (scope.zoneId && zones.length > 0 && !zones.includes(scope.zoneId.toLowerCase())) {
		return { ok: false, status: 403, message: "Zone is not available on this deployment" };
	}

	// A zone-only route has no account to check against, so an unrestricted zone allowlist would
	// leave it ungated entirely.
	if (scope.zoneId && !scope.accountId && zones.length === 0) {
		return { ok: false, status: 403, message: "Zone is not available on this deployment" };
	}

	return null;
}

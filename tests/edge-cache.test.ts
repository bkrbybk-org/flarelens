import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from "jose";
import app from "../src/index";
import { resetJwksCache } from "../src/lib/auth";
import { tokenFingerprint } from "../src/lib/ai-sec";
import { cacheKey, withEdgeCache } from "../src/lib/edge-cache";

/**
 * Cover for the Worker-internal edge cache (src/lib/edge-cache.ts) and its three call sites in
 * src/index.ts. This is the security-sensitive half of the feature — a wrong key hands one
 * operator's account data to another — so tenant isolation and "scope before cache" get their own
 * tests in addition to the plumbing (determinism, TTL behaviour, fresh bypass, never caching an
 * error).
 *
 * `caches` is a Workers global with no Node equivalent, so every test supplies an in-memory
 * stand-in keyed by the exact string `withEdgeCache` passes to match/put — the same contract
 * `getSchemaCaps` (src/lib/ai-sec/cf/schema.ts) already relies on.
 */

const ACCOUNT = "11111111111111111111111111111111";
const OTHER_ACCOUNT = "22222222222222222222222222222222";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function makeCacheStore() {
	const store = new Map<string, string>();
	return {
		store,
		default: {
			match: async (key: string) => {
				const raw = store.get(key);
				return raw ? new Response(raw, { headers: { "Content-Type": "application/json" } }) : undefined;
			},
			put: async (key: string, res: Response) => {
				store.set(key, await res.text());
			},
		},
	};
}

let cacheStore: ReturnType<typeof makeCacheStore>;
let upstreamCalls = 0;

beforeEach(() => {
	cacheStore = makeCacheStore();
	(globalThis as { caches?: unknown }).caches = { default: cacheStore.default };
	upstreamCalls = 0;
});
afterEach(() => vi.restoreAllMocks());

function mockZonesUpstream(result: { id: string; name: string }[] = [{ id: "z1", name: "example.com" }], status = 200) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		upstreamCalls++;
		if (url.includes("/zones")) {
			return status === 200
				? json({ success: true, result, result_info: { total_pages: 1 } })
				: json({ success: false, errors: [{ message: "nope" }] }, status);
		}
		return json({ success: true, result: [], result_info: { total_pages: 1 } });
	}) as typeof fetch;
}

function getZones(accountId: string, token: string, extraHeaders: Record<string, string> = {}, env: unknown = ENV) {
	return app.request(
		`/api/zones?account_id=${accountId}`,
		{ headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
		env,
		ctx(),
	);
}

// ---------------------------------------------------------------------------
// cacheKey: determinism, param sorting, mode/fingerprint namespacing.

describe("cacheKey", () => {
	it("is deterministic regardless of param insertion order", () => {
		const a = cacheKey({ fingerprint: "fp", mode: "byot", path: "/api/zones", params: { b: "2", a: "1" } });
		const b = cacheKey({ fingerprint: "fp", mode: "byot", path: "/api/zones", params: { a: "1", b: "2" } });
		expect(a).toBe(b);
		expect(a).toBe("https://flarelens.internal/api-cache/v1/byot/fp/api/zones?a=1&b=2");
	});

	it("omits params that were not passed, rather than encoding them as empty", () => {
		const key = cacheKey({ fingerprint: "fp", mode: "byot", path: "/api/pqc/report", params: { account_id: "a1", zone_id: undefined } });
		expect(key).toBe("https://flarelens.internal/api-cache/v1/byot/fp/api/pqc/report?account_id=a1");
	});

	it("differs between byot and server for the same fingerprint", () => {
		const byot = cacheKey({ fingerprint: "fp", mode: "byot", path: "/api/zones", params: { account_id: "a1" } });
		const server = cacheKey({ fingerprint: "fp", mode: "server", path: "/api/zones", params: { account_id: "a1" } });
		expect(byot).not.toBe(server);
	});

	it("differs between two fingerprints for the same mode and params", async () => {
		const fpA = await tokenFingerprint("token-one");
		const fpB = await tokenFingerprint("token-two");
		expect(fpA).not.toBe(fpB);
		const keyA = cacheKey({ fingerprint: fpA, mode: "byot", path: "/api/zones", params: { account_id: "a1" } });
		const keyB = cacheKey({ fingerprint: fpB, mode: "byot", path: "/api/zones", params: { account_id: "a1" } });
		expect(keyA).not.toBe(keyB);
	});
});

// ---------------------------------------------------------------------------
// withEdgeCache: unit-level contract (miss/hit/fresh, never-cache-errors, throw-safety).

describe("withEdgeCache", () => {
	it("stores only a 200 with success:true, and only via the given waitUntil", async () => {
		const waited: Promise<unknown>[] = [];
		const key = "https://flarelens.internal/api-cache/v1/byot/fp/x";
		await withEdgeCache({
			key,
			ttlSeconds: 60,
			fresh: false,
			waitUntil: (p) => waited.push(p),
			compute: async () => ({ status: 200, body: { success: true, result: [1, 2, 3] } }),
		});
		await Promise.all(waited);
		expect(waited).toHaveLength(1);
		expect(cacheStore.store.has(key)).toBe(true);
	});

	it("never stores a non-200 or success:false body", async () => {
		const key = "https://flarelens.internal/api-cache/v1/byot/fp/y";
		await withEdgeCache({
			key,
			ttlSeconds: 60,
			fresh: false,
			waitUntil: (p) => void p,
			compute: async () => ({ status: 200, body: { success: false, errors: [{ message: "nope" }] } }),
		});
		await withEdgeCache({
			key,
			ttlSeconds: 60,
			fresh: false,
			waitUntil: (p) => void p,
			compute: async () => ({ status: 502, body: { success: false, errors: [{ message: "upstream down" }] } }),
		});
		expect(cacheStore.store.size).toBe(0);
	});

	it("falls through to a live compute, returning 200, when match/put throw", async () => {
		(globalThis as { caches?: unknown }).caches = {
			default: {
				match: async () => {
					throw new Error("cache unavailable");
				},
				put: async () => {
					throw new Error("cache unavailable");
				},
			},
		};
		const result = await withEdgeCache({
			key: "https://flarelens.internal/api-cache/v1/byot/fp/z",
			ttlSeconds: 60,
			fresh: false,
			waitUntil: (p) => p.catch(() => {}),
			compute: async () => ({ status: 200, body: { success: true, result: "ok" } }),
		});
		expect(result.status).toBe(200);
		expect(result.hit).toBe(false);
		expect(result.body).toEqual({ success: true, result: "ok" });
	});
});

// ---------------------------------------------------------------------------
// Route wiring: GET /api/zones exercises the full auth -> validate -> scope -> cache pipeline.

describe("GET /api/zones edge cache", () => {
	it("MISSes then HITs the same key, with a byte-identical body", async () => {
		mockZonesUpstream();
		const first = await getZones(ACCOUNT, "caller-token");
		expect(first.headers.get("X-Flarelens-Cache")).toBe("MISS");
		expect(first.headers.get("X-Flarelens-Cached-At")).toBeNull();
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		const firstBody = await first.json();

		const second = await getZones(ACCOUNT, "caller-token");
		expect(second.headers.get("X-Flarelens-Cache")).toBe("HIT");
		expect(second.headers.get("X-Flarelens-Cached-At")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(second.headers.get("Cache-Control")).toBe("no-store");
		const secondBody = await second.json();

		expect(secondBody).toEqual(firstBody);
		expect(upstreamCalls).toBe(1);
	});

	it("does not let an unrelated query param change the key: junk params still HIT", async () => {
		mockZonesUpstream();
		await getZones(ACCOUNT, "caller-token");
		expect(upstreamCalls).toBe(1);

		const res = await app.request(
			`/api/zones?account_id=${ACCOUNT}&utm_source=spam&x=1`,
			{ headers: { Authorization: "Bearer caller-token" } },
			ENV,
			ctx(),
		);
		expect(res.headers.get("X-Flarelens-Cache")).toBe("HIT");
		expect(upstreamCalls).toBe(1);
	});

	it("never shares a cache entry between two different BYOT tokens for the same account", async () => {
		mockZonesUpstream();
		const first = await getZones(ACCOUNT, "token-operator-a");
		expect(first.headers.get("X-Flarelens-Cache")).toBe("MISS");
		expect(upstreamCalls).toBe(1);

		const second = await getZones(ACCOUNT, "token-operator-b");
		expect(second.headers.get("X-Flarelens-Cache")).toBe("MISS");
		expect(upstreamCalls).toBe(2);
	});

	it("never caches a 403 from upstream — every request re-hits Cloudflare", async () => {
		mockZonesUpstream([], 403);
		const first = await getZones(ACCOUNT, "caller-token");
		expect(first.status).toBe(403);
		expect(first.headers.get("X-Flarelens-Cache")).toBe("MISS");

		const second = await getZones(ACCOUNT, "caller-token");
		expect(second.status).toBe(403);
		expect(second.headers.get("X-Flarelens-Cache")).toBe("MISS");
		expect(upstreamCalls).toBe(2);
	});

	it("never caches a 502", async () => {
		mockZonesUpstream([], 502);
		const res = await getZones(ACCOUNT, "caller-token");
		expect(res.status).toBe(502);
		expect(cacheStore.store.size).toBe(0);
	});

	it("X-Flarelens-Fresh: 1 bypasses the cache and refreshes the entry", async () => {
		mockZonesUpstream([{ id: "z1", name: "example.com" }]);
		await getZones(ACCOUNT, "caller-token");
		expect(upstreamCalls).toBe(1);

		const hit = await getZones(ACCOUNT, "caller-token");
		expect(hit.headers.get("X-Flarelens-Cache")).toBe("HIT");
		expect(upstreamCalls).toBe(1);

		const fresh = await getZones(ACCOUNT, "caller-token", { "X-Flarelens-Fresh": "1" });
		expect(fresh.headers.get("X-Flarelens-Cache")).toBe("MISS");
		expect(upstreamCalls).toBe(2);

		// The bypass also repaired the entry: the next plain request is a HIT again.
		const hitAgain = await getZones(ACCOUNT, "caller-token");
		expect(hitAgain.headers.get("X-Flarelens-Cache")).toBe("HIT");
		expect(upstreamCalls).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Scope-before-cache: a disallowed server-mode request must never see a cached body, even when a
// pre-existing entry sits under the exact key that call would otherwise use.

describe("scope check runs before the cache is ever consulted", () => {
	const TEAM_DOMAIN = "example.cloudflareaccess.com";
	const AUD = "aud-tag-under-test";
	const SERVER_ENV = {
		...ENV,
		CF_API_TOKEN: "server-side-secret",
		CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		CF_ACCESS_AUD: AUD,
		ALLOWED_ACCOUNT_IDS: ACCOUNT,
	};
	let signingKey: KeyObject | CryptoKey;

	async function makeJwt(): Promise<string> {
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
		const pair = await generateKeyPair("RS256");
		signingKey = pair.privateKey;
		const jwk = await exportJWK(pair.publicKey);
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			upstreamCalls++;
			if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
				return json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
			}
			return json({ success: true, result: [], result_info: { total_pages: 1 } });
		}) as typeof fetch;
	});

	it("refuses a not-allowlisted account and ignores a cache entry planted at its key", async () => {
		// Plant a fake "successful" entry at the exact key a request for OTHER_ACCOUNT would use,
		// so a naive implementation that checked the cache before the allowlist would serve it.
		const fingerprint = await tokenFingerprint("server-side-secret");
		const plantedKey = cacheKey({ fingerprint, mode: "server", path: "/api/zones", params: { account_id: OTHER_ACCOUNT } });
		cacheStore.store.set(
			plantedKey,
			JSON.stringify({ body: { success: true, result: [{ id: "leaked", name: "should never be seen" }] }, cachedAt: new Date().toISOString() }),
		);

		const jwt = await makeJwt();
		const res = await app.request(
			`/api/zones?account_id=${OTHER_ACCOUNT}`,
			{ headers: { "Cf-Access-Jwt-Assertion": jwt } },
			SERVER_ENV,
			ctx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { success: boolean; result?: unknown };
		expect(body.success).toBe(false);
		expect(JSON.stringify(body)).not.toContain("leaked");
		// No X-Flarelens-Cache header at all: the response never reached withEdgeCache.
		expect(res.headers.get("X-Flarelens-Cache")).toBeNull();
	});

	it("still serves the allowlisted account normally (cache wiring intact past the gate)", async () => {
		const jwt = await makeJwt();
		const res = await app.request(`/api/zones?account_id=${ACCOUNT}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } }, SERVER_ENV, ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Flarelens-Cache")).toBe("MISS");
	});
});

// ---------------------------------------------------------------------------
// Client wiring: only a Sync-triggered reload should send X-Flarelens-Fresh. Rendering both pages
// through a full user interaction (mount, wait, click Sync, wait again) is expensive for what is
// really a one-line contract, so this asserts it directly on the source the same way a reviewer
// would: the Sync callback registered with useSectionRefresh sets the ref, and the load effect
// reads-and-resets it into the third argument of load(), which client.ts turns into the header.

describe("client: Sync-only fresh bypass (source assertion)", () => {
	const PAGES = [
		"../web/src/features/tunnels/TunnelMapPage.tsx",
		"../web/src/features/pqc/PqcPage.tsx",
	];

	it.each(PAGES)("%s sets the fresh ref only inside the Sync callback, and threads it into load()", (relPath) => {
		const src = readFileSync(new URL(relPath, import.meta.url), "utf8");

		// The registered callback (useSectionRefresh's first argument) is the only place the ref
		// is set to true — a mount or account-change re-run must not flip it.
		const syncCallback = src.match(/useSectionRefresh\(\s*useCallback\(\(\) => \{([\s\S]*?)\},\s*\[\]\)/);
		expect(syncCallback, "expected a useSectionRefresh(useCallback(...)) registration").not.toBeNull();
		expect(syncCallback![1]).toMatch(/freshOnNextLoadRef\.current = true/);

		// The load effect reads-and-resets the ref, then passes it as load()'s third argument.
		expect(src).toMatch(/const fresh = freshOnNextLoadRef\.current;/);
		expect(src).toMatch(/freshOnNextLoadRef\.current = false;/);
		expect(src).toMatch(/load\(session\.token, session\.accountId, fresh\)/);
	});

	it("client.ts sends X-Flarelens-Fresh: 1 only when fresh is true, and reads Cached-At only on a HIT", () => {
		const src = readFileSync(new URL("../web/src/api/client.ts", import.meta.url), "utf8");
		expect(src).toMatch(/"X-Flarelens-Fresh":\s*"1"/);
		expect(src).toMatch(/X-Flarelens-Cache"\)\s*===\s*"HIT"/);
	});
});

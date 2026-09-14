import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { ctx } from "./helpers/execution-context";

/**
 * System-level cover: every route driven through the real Hono app against one mocked
 * Cloudflare, asserting the composed response a browser would receive — not the internals.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ZONE = "44444444444444444444444444444444";
const TOKEN = "caller-token";

const assets = {
	fetch: async (req: Request) =>
		new URL(req.url).pathname === "/"
			? new Response("<!doctype html><title>Flarelens</title>", { headers: { "Content-Type": "text/html" } })
			: new Response("", { status: 404 }),
};
const ENV = { ASSETS: assets };

function get(path: string, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
	return app.request(path, { headers }, ENV, ctx());
}
function post(path: string, body: unknown) {
	return app.request(
		path,
		{ method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		ENV,
		ctx(),
	);
}

beforeEach(() => {
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
		const list = (result: unknown[]) => json({ success: true, result, result_info: { total_pages: 1 } });

		if (url.includes("/graphql")) return json({ data: {} });
		if (url.includes("/accounts?") || url.endsWith("/accounts")) return list([{ id: ACCOUNT, name: "NFR - TH - NTT" }]);
		if (url.includes("/zones?")) return list([{ id: ZONE, name: "example.com" }]);
		if (url.includes(`/zones/${ZONE}`)) return json({ success: true, result: { id: ZONE, name: "example.com" } });
		if (url.includes("/access/apps") && url.includes("/policies")) return list([{ id: "pol-1", name: "Allow team", decision: "allow" }]);
		if (url.includes("/access/apps")) return list([{ id: "app-1", name: "Internal", domain: "app.example.com" }]);
		if (url.includes("/access/identity_providers")) return list([{ id: "idp-1", name: "Okta", type: "okta" }]);
		if (url.includes("/access/groups")) return list([{ id: "grp-1", name: "Engineers" }]);
		if (url.includes("/access/policies")) return list([{ id: "pol-r", name: "Reusable", decision: "allow", reusable: true }]);
		if (url.includes("/rulesets")) return list([]);
		return list([]);
	}) as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe("GET /health", () => {
	it("answers without authentication", async () => {
		const res = await get("/health", {});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

describe("GET /api/accounts", () => {
	it("returns the accounts the token can see", async () => {
		const res = await get("/api/accounts");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { id: string }[] };
		expect(body.result[0].id).toBe(ACCOUNT);
	});
});

describe("GET /api/zones", () => {
	it("returns id and name only", async () => {
		const res = await get(`/api/zones?account_id=${ACCOUNT}`);
		const body = (await res.json()) as { result: Record<string, unknown>[] };
		expect(Object.keys(body.result[0]).sort()).toEqual(["id", "name"]);
	});

	it("400s without an account id", async () => {
		expect((await get("/api/zones")).status).toBe(400);
	});
});

describe("GET /api/data", () => {
	it("merges apps, policies, idps and groups into one payload", async () => {
		const res = await get(`/api/data?account_id=${ACCOUNT}`);
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as {
			result: { apps: { policies: unknown[]; self_hosted_domains: string[] }[]; idps: unknown[]; groups: unknown[] };
		};
		expect(result.apps).toHaveLength(1);
		expect(result.apps[0].policies).toHaveLength(1);
		expect(result.idps).toHaveLength(1);
		expect(result.groups).toHaveLength(1);
	});

	it("derives self_hosted_domains from a bare domain", async () => {
		const res = await get(`/api/data?account_id=${ACCOUNT}`);
		const { result } = (await res.json()) as { result: { apps: { self_hosted_domains: string[] }[] } };
		expect(result.apps[0].self_hosted_domains).toEqual(["app.example.com"]);
	});

	it("400s without an account id", async () => {
		expect((await get("/api/data")).status).toBe(400);
	});
});

describe("POST /api/waf/events", () => {
	it("returns events with diagnostics describing the query it ran", async () => {
		const res = await post("/api/waf/events", { accountId: ACCOUNT, minutes: 360 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { diagnostics: { scope: string; minutes: number } };
		expect(body.diagnostics.scope).toBe("account");
		expect(body.diagnostics.minutes).toBe(360);
	});

	it("reports zone scope when a zone is supplied", async () => {
		const res = await post("/api/waf/events", { accountId: ACCOUNT, zoneId: ZONE });
		const body = (await res.json()) as { diagnostics: { scope: string } };
		expect(body.diagnostics.scope).toBe("zone");
	});

	it("clamps an absurd lookback into the supported range", async () => {
		const res = await post("/api/waf/events", { accountId: ACCOUNT, minutes: 999_999 });
		const body = (await res.json()) as { diagnostics: { minutes: number } };
		expect(body.diagnostics.minutes).toBe(43_200);
	});

	it("clamps a too-small lookback up to the minimum", async () => {
		const res = await post("/api/waf/events", { accountId: ACCOUNT, minutes: 1 });
		const body = (await res.json()) as { diagnostics: { minutes: number } };
		expect(body.diagnostics.minutes).toBe(5);
	});
});

describe("GET /api/waf/rulesets", () => {
	it("returns a rule metadata map", async () => {
		const res = await get(`/api/waf/rulesets?account_id=${ACCOUNT}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; result: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(typeof body.result).toBe("object");
	});

	it("400s on a malformed account id", async () => {
		expect((await get("/api/waf/rulesets?account_id=nope")).status).toBe(400);
	});
});

describe("static asset fallback", () => {
	it("serves the SPA shell at the root", async () => {
		const res = await app.request("/", undefined, ENV, ctx());
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Flarelens");
	});

	it("404s an unknown path rather than falling back to the shell", async () => {
		expect((await app.request("/nope.json", undefined, ENV, ctx())).status).toBe(404);
	});
});

describe("cross-cutting response contract", () => {
	const cases = [
		["/health", {}],
		["/api/accounts", { Authorization: `Bearer ${TOKEN}` }],
		["/", {}],
	] as const;

	it.each(cases)("sets the security headers on %s", async (path, headers) => {
		const res = await app.request(path, { headers }, ENV, ctx());
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	});

	it("marks every API response no-store, and leaves assets cacheable", async () => {
		expect((await get("/api/accounts")).headers.get("Cache-Control")).toBe("no-store");
		expect((await app.request("/", undefined, ENV, ctx())).headers.get("Cache-Control")).not.toBe("no-store");
	});
});

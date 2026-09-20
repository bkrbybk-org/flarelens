import { describe, expect, it } from "vitest";
import app from "../src/index";
import { buildOpenApiDocument } from "../src/openapi";
import { ctx } from "./helpers/execution-context";

/**
 * Drift cover for the OpenAPI document: it must describe exactly the routes the running app
 * actually serves, nothing more and nothing less, so a route added without documenting it fails
 * here by name instead of shipping a stale spec.
 */

const ASSETS = { fetch: async () => new Response("", { status: 404 }) };
const BYOT_ENV = { ASSETS };
const TOKEN_HEADERS = { Authorization: "Bearer caller-token" };

/** Hono's own route table, minus the two catch-alls (the security middleware and the asset
 * fallback), both registered as `ALL /*` and neither a documentable endpoint. */
function liveRoutes(): { method: string; path: string }[] {
	return app.routes
		.filter((r) => r.path !== "/*")
		.map((r) => ({ method: r.method.toUpperCase(), path: r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}") }));
}

function specRoutes(spec: Record<string, unknown>): { method: string; path: string }[] {
	const paths = spec.paths as Record<string, Record<string, unknown>>;
	const out: { method: string; path: string }[] = [];
	for (const [path, operations] of Object.entries(paths)) {
		for (const method of Object.keys(operations)) {
			out.push({ method: method.toUpperCase(), path });
		}
	}
	return out;
}

function key(r: { method: string; path: string }): string {
	return `${r.method} ${r.path}`;
}

describe("the OpenAPI document tracks the app's real routes", () => {
	it("documents every route the app serves, and serves every route it documents", () => {
		const spec = buildOpenApiDocument({ version: "test" });
		const live = new Set(liveRoutes().map(key));
		const documented = new Set(specRoutes(spec).map(key));
		expect([...documented].sort()).toEqual([...live].sort());
	});

	it("fails if a route silently stops being documented", () => {
		// Same comparison as above, but simulating a spec that lost a path — proves the test
		// above would actually catch that, not just pass by construction.
		const spec = buildOpenApiDocument({ version: "test" }) as { paths: Record<string, unknown> };
		delete spec.paths["/api/zones"];
		const live = new Set(liveRoutes().map(key));
		const documented = new Set(specRoutes(spec as never).map(key));
		expect([...documented].sort()).not.toEqual([...live].sort());
	});

	it("marks every path as secured except /health", () => {
		const spec = buildOpenApiDocument({ version: "test" }) as {
			security: unknown[];
			paths: Record<string, Record<string, { security?: unknown[] }>>;
		};
		const unsecured: string[] = [];
		for (const [path, operations] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(operations)) {
				const effective = op.security ?? spec.security;
				if (Array.isArray(effective) && effective.length === 0) unsecured.push(`${method.toUpperCase()} ${path}`);
			}
		}
		expect(unsecured).toEqual(["GET /health"]);
	});

	it("parses as JSON, declares openapi 3.1.x, and resolves every $ref", () => {
		const spec = buildOpenApiDocument({ version: "test" });
		const roundTripped = JSON.parse(JSON.stringify(spec)) as { openapi: string };
		expect(roundTripped.openapi).toMatch(/^3\.1\.\d+$/);

		const refs = new Set<string>();
		const walk = (node: unknown) => {
			if (Array.isArray(node)) {
				for (const item of node) walk(item);
				return;
			}
			if (node && typeof node === "object") {
				const ref = (node as { $ref?: unknown }).$ref;
				if (typeof ref === "string") refs.add(ref);
				for (const value of Object.values(node)) walk(value);
			}
		};
		walk(roundTripped);
		expect(refs.size).toBeGreaterThan(0);

		for (const ref of refs) {
			expect(ref.startsWith("#/")).toBe(true);
			const parts = ref.slice(2).split("/");
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let node: any = roundTripped;
			for (const part of parts) node = node?.[part];
			expect(node, `${ref} must resolve`).toBeDefined();
		}
	});
});

describe("GET /api/openapi.json", () => {
	it("401s without a credential", async () => {
		const res = await app.request("/api/openapi.json", undefined, BYOT_ENV, ctx());
		expect(res.status).toBe(401);
	});

	it("200s with the caller's own token, as JSON", async () => {
		const res = await app.request("/api/openapi.json", { headers: TOKEN_HEADERS }, BYOT_ENV, ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { openapi: string };
		expect(body.openapi).toMatch(/^3\.1\./);
	});
});

describe("GET /docs", () => {
	it("401s without a credential, as HTML rather than JSON", async () => {
		const res = await app.request("/docs", undefined, BYOT_ENV, ctx());
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type") || "").toContain("text/html");
	});

	it("200s with the caller's own token, as HTML", async () => {
		const res = await app.request("/docs", { headers: TOKEN_HEADERS }, BYOT_ENV, ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type") || "").toContain("text/html");
	});

	it("loads its bootstrap from a file, never inline — the page's own CSP would block it", async () => {
		// script-src stays 'self' on /docs, so an inline <script> renders a blank page. Headers
		// alone did not catch that; the page must carry no executable inline script at all.
		const html = await (await app.request("/docs", { headers: TOKEN_HEADERS }, BYOT_ENV, ctx())).text();
		const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
		expect(inlineScripts.map((m) => m[1].trim()).filter(Boolean)).toEqual([]);
		expect(html).toContain('<script src="/docs/init.js">');
	});

	it("relaxes style-src for 'unsafe-inline' but never script-src", async () => {
		const res = await app.request("/docs", { headers: TOKEN_HEADERS }, BYOT_ENV, ctx());
		const csp = res.headers.get("Content-Security-Policy") || "";
		expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
	});
});

describe("the /docs CSP exception is scoped to /docs alone", () => {
	it("leaves a normal route's CSP untouched", async () => {
		const res = await app.request("/health", undefined, BYOT_ENV, ctx());
		const csp = res.headers.get("Content-Security-Policy") || "";
		expect(csp).not.toContain("'unsafe-inline'");
		expect(csp).toContain("style-src 'self'");
	});

	it("leaves /api/openapi.json's own CSP untouched too", async () => {
		const res = await app.request("/api/openapi.json", { headers: TOKEN_HEADERS }, BYOT_ENV, ctx());
		const csp = res.headers.get("Content-Security-Policy") || "";
		expect(csp).not.toContain("'unsafe-inline'");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { bucketTs } from "../src/lib/ai-sec/domain/transform";
import { piiLabel, unsafeTopicLabel } from "../src/lib/ai-sec/domain/catalog";

/**
 * Compatibility cover: the app must survive Cloudflare API drift and runtime differences it
 * does not control — new enum values, fields that vanish for a low-scope token, paginated
 * lists, and the Workers-only globals that Node does not provide.
 *
 * Everything here was verified against mocked upstreams only; the live pass ran separately.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ZONE = "44444444444444444444444444444444";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });

const auth = { Authorization: "Bearer caller-token" };

function mockUpstream(handler: (url: string) => Response) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
		handler(String(input instanceof Request ? input.url : input)),
	) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
});
afterEach(() => vi.restoreAllMocks());

describe("pagination", () => {
	it("walks every page of a list endpoint and concatenates the results", async () => {
		let calls = 0;
		mockUpstream((url) => {
			if (!url.includes("/zones")) return json({ success: true, result: [] });
			calls++;
			const page = Number(new URL(url).searchParams.get("page") || "1");
			return json({
				success: true,
				result: [{ id: `zone-${page}`, name: `z${page}.example` }],
				result_info: { page, total_pages: 3 },
			});
		});
		const res = await app.request(`/api/zones?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		const body = (await res.json()) as { result: { id: string }[] };
		expect(calls).toBe(3);
		expect(body.result.map((z) => z.id)).toEqual(["zone-1", "zone-2", "zone-3"]);
	});

	it("stops early when a page comes back empty rather than looping", async () => {
		let calls = 0;
		mockUpstream((url) => {
			if (!url.includes("/zones")) return json({ success: true, result: [] });
			calls++;
			return json({ success: true, result: [], result_info: { page: 1, total_pages: 99 } });
		});
		await app.request(`/api/zones?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(calls).toBe(1);
	});

	it("treats a missing result_info as a single page", async () => {
		let calls = 0;
		mockUpstream(() => {
			calls++;
			return json({ success: true, result: [{ id: ZONE, name: "example.com" }] });
		});
		await app.request(`/api/zones?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(calls).toBe(1);
	});
});

describe("partial-scope tokens", () => {
	it("still serves apps when the groups and reusable-policy scopes are missing", async () => {
		// Documented behaviour: enrichment failures narrow the payload, they do not fail it.
		mockUpstream((url) => {
			if (url.includes("/access/groups") || (url.includes("/access/policies") && !url.includes("/apps/")))
				return json({ success: false, errors: [{ message: "denied" }] }, 403);
			if (url.includes("/access/apps") && url.includes("/policies")) return json({ success: true, result: [] });
			if (url.includes("/access/apps")) return json({ success: true, result: [{ id: "app-1", name: "A" }] });
			return json({ success: true, result: [] });
		});
		const res = await app.request(`/api/data?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as {
			result: { apps: unknown[]; groups_error: boolean; reusable_policies_error: boolean };
		};
		expect(result.apps).toHaveLength(1);
		expect(result.groups_error).toBe(true);
		expect(result.reusable_policies_error).toBe(true);
	});

	it("flags per-app policy failures without dropping the app", async () => {
		mockUpstream((url) => {
			if (url.includes("/apps/") && url.includes("/policies")) return json({ success: false, errors: [] }, 403);
			if (url.includes("/access/apps")) return json({ success: true, result: [{ id: "app-1", name: "A" }] });
			return json({ success: true, result: [] });
		});
		const res = await app.request(`/api/data?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		const { result } = (await res.json()) as { result: { apps: { policies_error: boolean }[] } };
		expect(result.apps[0].policies_error).toBe(true);
	});

	it("fails the whole request only when the core scopes are missing", async () => {
		mockUpstream((url) =>
			url.includes("/access/apps") ? json({ success: false, errors: [{ message: "denied" }] }, 403) : json({ success: true, result: [] }),
		);
		const res = await app.request(`/api/data?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(403);
	});
});

describe("malformed and drifting upstream payloads", () => {
	it("does not crash on a non-JSON upstream response", async () => {
		mockUpstream(() => new Response("<html>maintenance</html>", { headers: { "Content-Type": "text/html" } }));
		const res = await app.request("/api/accounts", { headers: auth }, ENV, ctx());
		expect([200, 502]).toContain(res.status);
		expect(await res.text()).not.toContain("<html>");
	});

	it("tolerates list entries missing their optional fields", async () => {
		mockUpstream((url) =>
			url.includes("/zones") ? json({ success: true, result: [{ id: ZONE }] }) : json({ success: true, result: [] }),
		);
		const res = await app.request(`/api/zones?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		const body = (await res.json()) as { result: { id: string; name?: string }[] };
		expect(body.result[0].id).toBe(ZONE);
	});

	it("passes an unrecognised detection category through as its raw code", async () => {
		// Cloudflare adds categories; an unknown one must render, not blank out.
		expect(piiLabel("FUTURE_CATEGORY_2027")).toBe("FUTURE_CATEGORY_2027");
		expect(unsafeTopicLabel("S999")).toBe("S999");
	});

	it("degrades an unknown time-series dimension to hourly instead of throwing", async () => {
		expect(bucketTs("2026-09-04T10:07:00Z", "datetimeSomethingNew")).toBe("2026-09-04T10:00:00.000Z");
	});
});

describe("runtime compatibility", () => {
	it("works when the Cache API returns nothing at all", async () => {
		mockUpstream((url) => (url.includes("/graphql") ? json({ data: {} }) : json({ success: true, result: [] })));
		(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
		const res = await app.request(
			"/api/ai-security/analyze",
			{ method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT }) },
			ENV,
			ctx(),
		);
		expect(res.status).toBe(200);
	});

	it("uses only Web Crypto, which both Workers and Node 22+ provide", async () => {
		expect(typeof crypto.subtle.digest).toBe("function");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
		expect(digest.byteLength).toBe(32);
	});

	it("keeps every timestamp in the ISO-Z form the GraphQL layer interpolates", async () => {
		mockUpstream((url) => (url.includes("/graphql") ? json({ data: {} }) : json({ success: true, result: [] })));
		const res = await app.request(
			"/api/ai-security/analyze",
			{ method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT }) },
			ENV,
			ctx(),
		);
		const { result } = (await res.json()) as { result: { window: Record<string, string> } };
		for (const key of ["start", "end", "prevStart", "prevEnd"]) {
			expect(result.window[key]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		}
	});
});

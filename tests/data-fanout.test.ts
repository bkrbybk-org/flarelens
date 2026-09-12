import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

/**
 * `/api/data` and the tunnel map used to fetch every application's policies one application at a
 * time. `GET /access/apps` already embeds them — verified byte-for-byte against the per-app
 * endpoint for every application on a real account — so the fan-out was pure latency: on an
 * account with 29 applications it was 29 extra round trips at five at a time, about six seconds
 * of a ten-second response.
 *
 * These pin both halves of the replacement: that the embedded policies are used when present,
 * and that an application missing the field is still asked about rather than assumed to have
 * none. The second half is what keeps `policies_error` honest — "the field was absent" and "this
 * application has no policies" are different facts, and only a request separates them.
 */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} });
const auth = { Authorization: "Bearer caller-token" };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let urls: string[] = [];

function mockUpstream(handler: (url: string) => Response) {
	urls = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		return handler(url);
	}) as typeof fetch;
}

const perAppPolicyCalls = () => urls.filter((u) => /\/access\/apps\/[^/]+\/policies/.test(u)).length;

const POLICY = { id: "pol-1", name: "Staff only", decision: "allow", include: [{ everyone: {} }] };

beforeEach(() => {
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
});
afterEach(() => vi.restoreAllMocks());

describe("/api/data policy resolution", () => {
	it("uses the policies embedded in the apps payload, asking for none of them again", async () => {
		mockUpstream((url) => {
			if (url.includes("/access/apps") && !url.includes("/policies")) {
				return json({
					success: true,
					result: [
						{ id: "app-1", name: "wiki", policies: [POLICY] },
						{ id: "app-2", name: "docs", policies: [] },
					],
				});
			}
			return json({ success: true, result: [] });
		});

		const res = await app.request(`/api/data?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		const { result } = (await res.json()) as {
			result: { apps: { id: string; policies: { id: string }[]; policies_error: boolean }[] };
		};

		expect(perAppPolicyCalls()).toBe(0);
		expect(result.apps[0].policies.map((p) => p.id)).toEqual(["pol-1"]);
		expect(result.apps[0].policies_error).toBe(false);
		// An empty embedded list is a real answer, not a missing one.
		expect(result.apps[1].policies).toEqual([]);
		expect(result.apps[1].policies_error).toBe(false);
	});

	it("asks only about the applications whose policies field is absent", async () => {
		// Cloudflare omits the field for some application types (private_ip today). Assuming
		// "no policies" there would invent an answer; assuming an error would invent a problem.
		mockUpstream((url) => {
			if (/\/access\/apps\/[^/]+\/policies/.test(url)) return json({ success: true, result: [POLICY] });
			if (url.includes("/access/apps")) {
				return json({
					success: true,
					result: [
						{ id: "app-1", name: "wiki", policies: [POLICY] },
						{ id: "app-2", name: "private" },
						{ id: "app-3", name: "also-private", policies: null },
					],
				});
			}
			return json({ success: true, result: [] });
		});

		const res = await app.request(`/api/data?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		const { result } = (await res.json()) as { result: { apps: { id: string; policies: unknown[] }[] } };

		expect(perAppPolicyCalls()).toBe(2);
		expect(urls.some((u) => u.includes("/access/apps/app-1/policies"))).toBe(false);
		expect(result.apps.every((a) => a.policies.length === 1)).toBe(true);
	});
});

describe("/api/access/tunnels policy resolution", () => {
	it("reads the same embedded policies rather than repeating the fan-out", async () => {
		mockUpstream((url) => {
			if (url.includes("/access/apps") && !url.includes("/policies")) {
				return json({
					success: true,
					result: [{ id: "app-1", name: "wiki", domain: "wiki.example.com", policies: [POLICY] }],
				});
			}
			if (url.includes("/cfd_tunnel")) return json({ success: true, result: [] });
			return json({ success: true, result: [] });
		});

		const res = await app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		expect(res.status).toBe(200);
		expect(perAppPolicyCalls()).toBe(0);
	});

	it("issues the tunnel-side reads together instead of one after another", async () => {
		// Configurations, private routes and Worker domains depend only on the tunnel list. Run
		// in sequence they cost three round trips of wall clock for no reason.
		const started: string[] = [];
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => { release = resolve; });

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url);
			if (url.includes("/teamnet/routes") || url.includes("/workers/domains") || url.includes("/configurations")) {
				started.push(url);
				await gate;
			}
			if (url.includes("/cfd_tunnel") && !url.includes("/configurations")) {
				return json({ success: true, result: [{ id: "t1", name: "tunnel", status: "healthy" }] });
			}
			return json({ success: true, result: [] });
		}) as typeof fetch;
		urls = [];

		const pending = app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, { headers: auth }, ENV, ctx());
		// Let the tunnel list resolve and the next wave be issued.
		await new Promise((r) => setTimeout(r, 20));
		const inFlight = started.length;
		release?.();
		await pending;

		// All three were in flight before any of them completed.
		expect(inFlight).toBe(3);
	});
});

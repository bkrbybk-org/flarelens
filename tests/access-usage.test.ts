import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_ACCESS_RANGE_MS, isAccessGranularity } from "../src/lib/access-usage";
import { formatLogins, successRate } from "../web/src/features/access-usage/types";

/** Cover for the Access usage route: validation, folding, name resolution and privacy posture. */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlBodies: { query: string; variables: Record<string, unknown> }[] = [];

/** isSuccessfulLogin is a uint8 in the real schema: 1 success, 0 failure. */
const row = (dims: Record<string, string | number>, count: number) => ({ count, dimensions: dims });

function mockUpstream(accounts: Record<string, unknown>) {
	graphqlBodies = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
		if (url.includes("/graphql")) {
			graphqlBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return json({ data: { viewer: { accounts: [accounts] } } });
		}
		if (url.includes("/access/apps")) {
			return json({ success: true, result: [{ id: "app-uuid-1", name: "Certificates Tracking" }], result_info: { total_pages: 1 } });
		}
		if (url.includes("/access/identity_providers")) {
			return json({ success: true, result: [{ id: "idp-1", name: "Okta" }], result_info: { total_pages: 1 } });
		}
		return json({ success: true, result: [], result_info: { total_pages: 1 } });
	}) as typeof fetch;
}

// Inside the upstream 1-week cap, with room to spare.
const win = () => ({
	from: new Date(Date.now() - 6 * 86_400_000).toISOString(),
	to: new Date().toISOString(),
});

const usage = (body: Record<string, unknown>) =>
	app.request("/api/access/usage", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV);

beforeEach(() => {
	mockUpstream({
		series: [
			row({ datetimeHour: "2026-09-04T10:00:00Z", isSuccessfulLogin: 1 }, 100),
			row({ datetimeHour: "2026-09-04T10:00:00Z", isSuccessfulLogin: 0 }, 5),
			row({ datetimeHour: "2026-09-04T09:00:00Z", isSuccessfulLogin: 1 }, 20),
		],
		byApp: [
			row({ appId: "app-uuid-1", isSuccessfulLogin: 1 }, 90),
			row({ appId: "app-uuid-1", isSuccessfulLogin: 0 }, 5),
			row({ appId: "deleted-app-uuid", isSuccessfulLogin: 1 }, 30),
		],
		byIdp: [row({ identityProvider: "onetimepin", isSuccessfulLogin: 1 }, 120)],
		byCountry: [row({ country: "TH", isSuccessfulLogin: 1 }, 120)],
	});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/access/usage", () => {
	it("folds success and failure rows into one point per bucket, in time order", async () => {
		const res = await usage({ accountId: ACCOUNT, ...win() });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: { series: { ts: string; success: number; failure: number }[] } };
		expect(result.series).toEqual([
			{ ts: "2026-09-04T09:00:00Z", success: 20, failure: 0 },
			{ ts: "2026-09-04T10:00:00Z", success: 100, failure: 5 },
		]);
	});

	it("totals success and failure across the window", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { totals: { success: number; failure: number; total: number } };
		};
		expect(result.totals).toEqual({ success: 120, failure: 5, total: 125 });
	});

	it("resolves app uuids to names, keeping unmatched ids visible", async () => {
		// An id with no match is usually a deleted app; dropping it would silently lose logins.
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { byApp: { key: string; appId?: string; total: number }[] };
		};
		expect(result.byApp[0]).toEqual({ key: "Certificates Tracking", appId: "app-uuid-1", success: 90, failure: 5, total: 95 });
		expect(result.byApp[1].key).toBe("deleted-app-uuid");
	});

	it("keeps the raw uuid so a caller can join on it rather than on a display name", async () => {
		// The Applications table joins these counts back onto the application list. Names repeat,
		// get renamed, and are missing for a deleted app; the uuid is the only stable key.
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { byApp: { key: string; appId?: string }[] };
		};
		expect(result.byApp.every((row) => typeof row.appId === "string" && row.appId.length > 0)).toBe(true);
		// The unresolved row keeps its uuid in both fields, so the join still succeeds for it.
		expect(result.byApp[1].appId).toBe("deleted-app-uuid");
	});

	it("orders breakdowns by total descending", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { byApp: { total: number }[] };
		};
		expect(result.byApp[0].total).toBeGreaterThanOrEqual(result.byApp[1].total);
	});

	it("never asks Cloudflare for per-user identity dimensions", async () => {
		// The dataset exposes userUuid, ipAddress and deviceId; this endpoint is aggregate-only.
		await usage({ accountId: ACCOUNT, ...win() });
		for (const field of ["userUuid", "ipAddress", "deviceId", "mtlsCertSerialId"]) {
			expect(graphqlBodies[0].query).not.toContain(field);
		}
	});

	it("switches the time dimension for daily granularity", async () => {
		mockUpstream({ series: [row({ date: "2026-09-04", isSuccessfulLogin: 1 }, 7)] });
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win(), granularity: "daily" })).json()) as {
			result: { timeDimension: string; series: { ts: string }[] };
		};
		expect(result.timeDimension).toBe("date");
		expect(result.series[0].ts).toBe("2026-09-04");
	});

	it("refuses a window wider than the upstream 1-week limit", async () => {
		// Cloudflare rejects these outright; catching it here gives a 400 with a readable
		// message instead of a 502 from upstream.
		const to = new Date();
		const from = new Date(to.getTime() - 8 * 86_400_000);
		const res = await usage({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() });
		expect(res.status).toBe(400);
		expect((await res.json() as { errors: { message: string }[] }).errors[0].message).toMatch(/7 days/);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("validates ids, instants, ordering and range length", async () => {
		expect((await usage({ accountId: "nope", ...win() })).status).toBe(400);
		expect((await usage({ accountId: ACCOUNT, from: "yesterday", to: "now" })).status).toBe(400);
		const w = win();
		expect((await usage({ accountId: ACCOUNT, from: w.to, to: w.from })).status).toBe(400);
		const to = new Date();
		const from = new Date(to.getTime() - MAX_ACCESS_RANGE_MS - 60_000);
		expect((await usage({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/access/usage",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, ...win() }) },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("still returns usage when the Access name lookups fail", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/graphql")) {
				return new Response(
					JSON.stringify({ data: { viewer: { accounts: [{ byApp: [row({ appId: "app-uuid-1", isSuccessfulLogin: 1 }, 4)] }] } } }),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ success: false, errors: [{ message: "denied" }] }), { status: 403 });
		}) as typeof fetch;
		const res = await usage({ accountId: ACCOUNT, ...win() });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: { byApp: { key: string }[] } };
		// Falls back to the raw uuid rather than failing the request.
		expect(result.byApp[0].key).toBe("app-uuid-1");
	});

	it("surfaces a GraphQL error as a 502", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/graphql")) {
				return new Response(JSON.stringify({ errors: [{ message: 'unknown field "appName"' }] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ success: true, result: [], result_info: { total_pages: 1 } }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		const res = await usage({ accountId: ACCOUNT, ...win() });
		expect(res.status).toBe(502);
	});

	it("accepts only the supported granularities", () => {
		expect(isAccessGranularity("hourly")).toBe(true);
		expect(isAccessGranularity("weekly")).toBe(false);
	});
});

describe("presentation helpers", () => {
	it("abbreviates login counts", () => {
		expect(formatLogins(950)).toBe("950");
		expect(formatLogins(2450)).toBe("2.5K");
	});

	it("reports a success rate, and a dash when nothing happened", () => {
		expect(successRate({ success: 95, total: 100 })).toBe("95.0%");
		expect(successRate({ success: 0, total: 0 })).toBe("—");
	});
});

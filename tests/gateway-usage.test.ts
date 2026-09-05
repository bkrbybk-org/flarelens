import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_GATEWAY_RANGE_MS, isGatewayGranularity } from "../src/lib/gateway-usage";

/** Cover for Zero Trust Gateway usage: verdict classification, multi-value dimensions, privacy. */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlBodies: { query: string }[] = [];

const row = (dimensions: Record<string, string | string[]>, count: number) => ({ count, dimensions });

function mockUpstream(account: Record<string, unknown>) {
	graphqlBodies = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/graphql")) {
			graphqlBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ success: true, result: [] }), { headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const win = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() });
const usage = (body: Record<string, unknown>) =>
	app.request("/api/gateway/usage", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV);

beforeEach(() => {
	mockUpstream({
		dnsSeries: [
			row({ datetimeHour: "2026-09-05T10:00:00Z", resolverDecision: "allowedOnNoPolicyMatch" }, 100),
			row({ datetimeHour: "2026-09-05T10:00:00Z", resolverDecision: "blockedOnBlockPolicy" }, 7),
			row({ datetimeHour: "2026-09-05T09:00:00Z", resolverDecision: "allowedOnAllowPolicy" }, 40),
		],
		dnsByCategory: [
			row({ categoryNames: ["Advertisements", "Trackers"], resolverDecision: "blockedOnBlockPolicy" }, 5),
			row({ categoryNames: [], resolverDecision: "allowedOnNoPolicyMatch" }, 90),
		],
		dnsByPolicy: [row({ policyName: "Block ads", resolverDecision: "blockedOnBlockPolicy" }, 5)],
		httpSeries: [
			row({ datetimeHour: "2026-09-05T10:00:00Z", action: "allow" }, 60),
			row({ datetimeHour: "2026-09-05T10:00:00Z", action: "block" }, 3),
		],
		httpByHost: [row({ httpHost: "example.com", action: "allow" }, 60)],
		httpByAction: [row({ action: "bypass" }, 65), row({ action: "quarantine" }, 2)],
	});
});
afterEach(() => vi.restoreAllMocks());

describe("verdict classification", () => {
	it("counts a verdict naming a block as blocked, and everything else as allowed", async () => {
		// The vocabulary is not documented anywhere we control, so an unfamiliar verdict must
		// never be silently counted as a block.
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { dns: { totals: { allowed: number; blocked: number; total: number } } };
		};
		expect(result.dns.totals).toEqual({ allowed: 140, blocked: 7, total: 147 });
	});

	it("treats quarantine as blocked", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { http: { byAction: { key: string; blocked: number; allowed: number }[] } };
		};
		const quarantine = result.http.byAction.find((r) => r.key === "quarantine");
		expect(quarantine?.blocked).toBe(2);
		expect(result.http.byAction.find((r) => r.key === "bypass")?.allowed).toBe(65);
	});

	it("folds series rows into one point per bucket, in time order", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { dns: { series: { ts: string; allowed: number; blocked: number }[] } };
		};
		expect(result.dns.series).toEqual([
			{ ts: "2026-09-05T09:00:00Z", allowed: 40, blocked: 0 },
			{ ts: "2026-09-05T10:00:00Z", allowed: 100, blocked: 7 },
		]);
	});
});

describe("multi-value dimensions", () => {
	it("counts a row against every category it carries", async () => {
		// categoryNames is an array: one query can match several categories at once.
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { dns: { byCategory: { key: string; blocked: number }[] } };
		};
		const keys = result.dns.byCategory.map((r) => r.key);
		expect(keys).toContain("Advertisements");
		expect(keys).toContain("Trackers");
		expect(result.dns.byCategory.find((r) => r.key === "Advertisements")?.blocked).toBe(5);
	});

	it("labels an empty category list rather than dropping its count", async () => {
		const { result } = (await (await usage({ accountId: ACCOUNT, ...win() })).json()) as {
			result: { dns: { byCategory: { key: string; total: number }[] } };
		};
		expect(result.dns.byCategory.find((r) => r.key === "(uncategorised)")?.total).toBe(90);
	});
});

describe("privacy posture", () => {
	it("never asks for per-user or per-device dimensions", async () => {
		// Both datasets expose these; the section is aggregate-only by design.
		await usage({ accountId: ACCOUNT, ...win() });
		for (const field of ["email", "userId", "deviceId", "sourceInternalIp", "srcIpCountry"]) {
			expect(graphqlBodies[0].query).not.toContain(field);
		}
	});
});

describe("validation", () => {
	it("rejects bad ids, bad instants, inverted and over-long ranges", async () => {
		expect((await usage({ accountId: "nope", ...win() })).status).toBe(400);
		expect((await usage({ accountId: ACCOUNT, from: "x", to: "y" })).status).toBe(400);
		const w = win();
		expect((await usage({ accountId: ACCOUNT, from: w.to, to: w.from })).status).toBe(400);
		const to = new Date();
		const from = new Date(to.getTime() - MAX_GATEWAY_RANGE_MS - 60_000);
		expect((await usage({ accountId: ACCOUNT, from: from.toISOString(), to: to.toISOString() })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/gateway/usage",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, ...win() }) },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("accepts only supported granularities", () => {
		expect(isGatewayGranularity("daily")).toBe(true);
		expect(isGatewayGranularity("monthly")).toBe(false);
	});

	it("surfaces a GraphQL error as a 502", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { headers: { "Content-Type": "application/json" } }),
		) as typeof fetch;
		expect((await usage({ accountId: ACCOUNT, ...win() })).status).toBe(502);
	});
});

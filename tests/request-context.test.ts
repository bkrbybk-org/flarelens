import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { ctx } from "./helpers/execution-context";
import type { RequestContext } from "../src/lib/request-context";

/** A traced request's surroundings: the drafted change's reach, the rule elsewhere, the client's timeline. */

const ACCOUNT = "11111111111111111111111111111111";
const ZONE = "44444444444444444444444444444444";
const RULE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

type Ctx = RequestContext & {
	impact: NonNullable<RequestContext["impact"]>;
	rule: NonNullable<RequestContext["rule"]>;
	timeline: NonNullable<RequestContext["timeline"]>;
};

let calls: { query: string; variables: Record<string, unknown> }[] = [];

function mockGraphql(answer: (query: string, variables: Record<string, unknown>) => unknown) {
	calls = [];
	globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const parsed = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ query: parsed.query, variables: parsed.variables });
		return new Response(JSON.stringify(answer(parsed.query, parsed.variables)), { headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const post = (body: Record<string, unknown>) =>
	app.request("/api/request/context", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV, ctx());

const groupsAnswer = (dataset: string, rows: unknown[]) => ({ data: { viewer: { zones: [{ [dataset]: rows }] } } });

beforeEach(() => {
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/request/context", () => {
	it("counts what an exception would release, and where the rule fired", async () => {
		mockGraphql((query, variables) => {
			const filter = variables.filter as Record<string, unknown>;
			if (query.includes("httpRequestsAdaptiveGroups")) {
				if (query.includes("securityAction")) return groupsAnswer("httpRequestsAdaptiveGroups", [{ count: 90, dimensions: { securityAction: "block" } }, { count: 10, dimensions: { securityAction: "unknown" } }]);
				return groupsAnswer("httpRequestsAdaptiveGroups", [{ count: 1 }, { count: 1 }, { count: 1 }]);
			}
			if (query.includes("firewallEventsAdaptiveGroups")) {
				if (filter.clientRequestHTTPHost) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 85 }]);
				if (filter.clientIP) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 7 }]);
				if (filter.clientRequestPath) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 40 }]);
				if (query.includes("dimensions { action }")) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 500, dimensions: { action: "block" } }]);
				if (query.includes("clientCountryName")) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 300, dimensions: { clientCountryName: "NL" } }]);
				if (query.includes("clientAsn")) return groupsAnswer("firewallEventsAdaptiveGroups", [{ count: 200, dimensions: { clientAsn: 64500, clientASNDescription: "Example Net" } }]);
				return groupsAnswer("firewallEventsAdaptiveGroups", []);
			}
			return groupsAnswer("httpRequestsAdaptive", [{ rayName: "a3633412999ba62b" }]);
		});
		const res = await post({
			accountId: ACCOUNT,
			zoneId: ZONE,
			ruleId: RULE,
			clientIP: "198.51.100.7",
			host: "example.com",
			path: "/login",
			around: "2026-10-27T10:00:00Z",
		});
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: Ctx };
		expect(result.errors).toEqual([]);
		expect(result.impact).toMatchObject({ requests: 100, distinctClients: 3, distinctCapped: false, ruleEvents: 85, filter: { host: "example.com", path: "/login" } });
		// An exception is about the request's kind, not this client: no IP in its filter.
		expect(result.impact.filter.clientIP).toBeUndefined();
		expect(result.rule).toMatchObject({ total: 500, sameClient: 7, samePath: 40 });
		expect(result.rule.topCountries).toEqual([{ value: "NL", count: 300 }]);
		expect(result.rule.topNetworks).toEqual([{ value: "AS64500 Example Net", count: 200 }]);
		expect(result.timeline.rows).toHaveLength(1);
		// The timeline is the hour either side of the request, for this client.
		const timeline = calls.find((c) => c.query.includes("Timeline"))!;
		expect(timeline.variables.filter).toMatchObject({ clientIP: "198.51.100.7", datetime_geq: "2026-10-27T09:00:00.000Z", datetime_leq: "2026-10-27T11:00:00.000Z" });
	});

	it("passes request values as variables, never inside the query text", async () => {
		mockGraphql(() => groupsAnswer("httpRequestsAdaptiveGroups", []));
		await post({ accountId: ACCOUNT, zoneId: ZONE, host: 'evil" } } {', path: "/x" });
		for (const call of calls) expect(call.query).not.toContain("evil");
		expect(calls.some((c) => (c.variables.filter as Record<string, unknown>).clientRequestHTTPHost === 'evil" } } {')).toBe(true);
	});

	it("narrows a drafted block by client IP", async () => {
		mockGraphql(() => groupsAnswer("httpRequestsAdaptiveGroups", []));
		const { result } = (await (await post({ accountId: ACCOUNT, zoneId: ZONE, host: "example.com", path: "/", clientIP: "198.51.100.7", impactIncludesIp: true })).json()) as {
			result: Ctx;
		};
		expect(result.impact.filter).toEqual({ host: "example.com", path: "/", clientIP: "198.51.100.7" });
	});

	it("names the part that failed and keeps the rest", async () => {
		mockGraphql((query) => (query.includes("firewallEventsAdaptiveGroups") ? { errors: [{ message: "not entitled" }] } : groupsAnswer("httpRequestsAdaptiveGroups", [{ count: 5, dimensions: { securityAction: "block" } }])));
		const { result } = (await (await post({ accountId: ACCOUNT, zoneId: ZONE, ruleId: RULE, host: "example.com", path: "/" })).json()) as {
			result: Ctx;
		};
		expect(result.rule).toBeUndefined();
		expect(result.errors.map((e: { part: string }) => e.part)).toContain("rule");
	});

	it("validates its inputs", async () => {
		mockGraphql(() => ({}));
		expect((await post({ accountId: ACCOUNT, zoneId: "bad" })).status).toBe(400);
		expect((await post({ accountId: ACCOUNT, zoneId: ZONE, ruleId: "not-hex" })).status).toBe(400);
		expect((await post({ accountId: ACCOUNT, zoneId: ZONE, clientIP: "1.2.3.4; drop" })).status).toBe(400);
		expect((await post({ accountId: ACCOUNT, zoneId: ZONE, around: "yesterday-ish" })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/request/context",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, zoneId: ZONE }) },
			ENV,
			ctx(),
		);
		expect(res.status).toBe(401);
	});
});

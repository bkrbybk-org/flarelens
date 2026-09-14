import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { normaliseRayId } from "../src/lib/request-trace";
import { ctx } from "./helpers/execution-context";

/** Cover for Ray ID forensics: input handling, the cross-zone search, and honest absence. */

const ACCOUNT = "11111111111111111111111111111111";
const ZONE_A = "44444444444444444444444444444444";
const ZONE_B = "33333333333333333333333333333333";
const RAY = "a3633412999ba62b";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };

let graphqlQueries: string[] = [];

/**
 * The prober walks the schema in three steps: the `zone` type's fields (to find each dataset and
 * its filter input), then each row type's fields, then the filter input's fields. The mock
 * answers all three so the field picker and the ray filter key resolve exactly as in production.
 */
const scalar = { name: "string", kind: "SCALAR", ofType: null };
const field = (name: string) => ({ name, type: scalar, args: [] });

const ROW_FIELDS: Record<string, string[]> = {
	ZoneHttpRequestsAdaptive: [
		"rayName",
		"datetime",
		"clientIP",
		"clientCountryName",
		"clientRequestHTTPHost",
		"clientRequestPath",
		"edgeResponseStatus",
		// Present in the schema but not entitled on every zone — the case the retry exists for.
		"fraudAttack",
	],
	ZoneFirewallEventsAdaptive: ["datetime", "action", "source", "ruleId", "clientRequestHTTPHost", "clientRequestPath"],
};

function probeResponse(query: string, variables: Record<string, unknown>) {
	if (query.includes("ProbeZone")) {
		return {
			__type: {
				fields: [
					{
						name: "httpRequestsAdaptive",
						type: { name: "ZoneHttpRequestsAdaptive", kind: "OBJECT", ofType: null },
						args: [{ name: "filter", type: { name: "ZoneHttpRequestsAdaptiveFilter_InputObject", kind: "INPUT_OBJECT", ofType: null } }],
					},
					{
						name: "firewallEventsAdaptive",
						type: { name: "ZoneFirewallEventsAdaptive", kind: "OBJECT", ofType: null },
						args: [{ name: "filter", type: { name: "ZoneFirewallEventsAdaptiveFilter_InputObject", kind: "INPUT_OBJECT", ofType: null } }],
					},
				],
			},
		};
	}
	const name = String(variables.name ?? "");
	if (name.endsWith("Filter_InputObject")) {
		return { __type: { inputFields: [field("rayName"), field("datetime_geq"), field("datetime_leq")] } };
	}
	return { __type: { fields: (ROW_FIELDS[name] ?? []).map(field) } };
}

function mockUpstream(rowsByZone: Record<string, { request?: unknown[]; firewall?: unknown[] }>) {
	graphqlQueries = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

		if (url.includes("/graphql")) {
			const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
			const variables = JSON.parse(String(init?.body ?? "{}")).variables ?? {};
			graphqlQueries.push(query);
			if (query.includes("__type")) return json({ data: probeResponse(query, variables) });
			const zone = String(variables.zoneTag ?? "");
			return json({ data: { viewer: { zones: [rowsByZone[zone] ?? {}] } } });
		}
		if (url.includes("/zones")) {
			return json({
				success: true,
				result: [{ id: ZONE_A, name: "example.com" }, { id: ZONE_B, name: "example.org" }],
				result_info: { total_pages: 1 },
			});
		}
		return json({ success: true, result: [], result_info: { total_pages: 1 } });
	}) as typeof fetch;
}

const trace = (body: Record<string, unknown>) =>
	app.request("/api/request/trace", { method: "POST", headers: auth, body: JSON.stringify(body) }, ENV, ctx());

beforeEach(() => {
	(globalThis as { caches?: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
	mockUpstream({});
});
afterEach(() => vi.restoreAllMocks());

describe("normaliseRayId", () => {
	it("accepts a bare ray and strips the colo suffix the dashboard shows", () => {
		expect(normaliseRayId(RAY)).toBe(RAY);
		expect(normaliseRayId(`${RAY}-BKK`)).toBe(RAY);
		expect(normaliseRayId(` ${RAY.toUpperCase()} `)).toBe(RAY);
	});

	it("rejects anything that is not 16 hex characters", () => {
		expect(normaliseRayId("nope")).toBeNull();
		expect(normaliseRayId(RAY.slice(0, 15))).toBeNull();
		expect(normaliseRayId(`${RAY}ff`)).toBeNull();
		expect(normaliseRayId(12345)).toBeNull();
	});
});

describe("adapting to what a zone will actually answer", () => {
	/** Cloudflare refuses a query naming a field the zone is not entitled to, by name. */
	function refuseThenSucceed(refusals: string[]) {
		let call = 0;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
			if (url.includes("/graphql")) {
				const parsed = JSON.parse(String(init?.body ?? "{}"));
				const query = String(parsed.query ?? "");
				if (query.includes("__type")) return json({ data: probeResponse(query, parsed.variables ?? {}) });
				graphqlQueries.push(query);
				const refusal = refusals[call];
				if (refusal && query.includes(refusal)) {
					call++;
					return json({ errors: [{ message: `zone 'z' does not have access to the field '${refusal.toLowerCase()}' from the path` }] });
				}
				return json({ data: { viewer: { zones: [{ request: [{ rayName: RAY }] }] } } });
			}
			if (url.includes("/zones")) {
				return json({ success: true, result: [{ id: ZONE_A, name: "example.com" }], result_info: { total_pages: 1 } });
			}
			return json({ success: true, result: [], result_info: { total_pages: 1 } });
		}) as typeof fetch;
	}

	it("drops a field the zone is not entitled to and retries, rather than losing the trace", async () => {
		// One unentitled field — fraud detection fields do this — used to reject the entire
		// query, so a swept field nobody asked for cost the whole answer.
		refuseThenSucceed(["fraudAttack"]);
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY })).json()) as {
			result: { foundIn?: { name: string }; droppedFields: string[] };
		};
		expect(result.foundIn?.name).toBe("example.com");
		expect(result.droppedFields).toContain("fraudAttack");
	});

	it("gives up on a zone rather than retrying forever", async () => {
		// A refusal naming a field that is not in the selection cannot be acted on.
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
			if (url.includes("/graphql")) {
				const parsed = JSON.parse(String(init?.body ?? "{}"));
				if (String(parsed.query).includes("__type")) return json({ data: probeResponse(String(parsed.query), parsed.variables ?? {}) });
				graphqlQueries.push(String(parsed.query));
				return json({ errors: [{ message: "something else entirely" }] });
			}
			if (url.includes("/zones")) return json({ success: true, result: [{ id: ZONE_A, name: "example.com" }], result_info: { total_pages: 1 } });
			return json({ success: true, result: [], result_info: { total_pages: 1 } });
		}) as typeof fetch;
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY })).json()) as {
			result: { errors: { message: string }[] };
		};
		expect(graphqlQueries.filter((q) => q.includes("RequestTrace"))).toHaveLength(1);
		expect(result.errors[0].message).toContain("something else");
	});
});

describe("POST /api/request/trace", () => {
	it("returns the request row and names the zone it was found in", async () => {
		mockUpstream({ [ZONE_B]: { request: [{ rayName: RAY, clientIP: "203.0.113.9", edgeResponseStatus: 403 }], firewall: [] } });
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY })).json()) as {
			result: { foundIn: { name: string }; request: Record<string, unknown> };
		};
		expect(result.foundIn.name).toBe("example.org");
		expect(result.request.clientIP).toBe("203.0.113.9");
	});

	it("stops searching once a zone matches", async () => {
		// A Ray ID identifies one request; a second match would mean reuse, not more detail.
		mockUpstream({
			[ZONE_A]: { request: [{ rayName: RAY }] },
			[ZONE_B]: { request: [{ rayName: RAY }] },
		});
		await trace({ accountId: ACCOUNT, rayId: RAY });
		const traceQueries = graphqlQueries.filter((q) => q.includes("RequestTrace"));
		expect(traceQueries).toHaveLength(1);
	});

	it("reports absence without claiming the request never happened", async () => {
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY })).json()) as {
			result: { foundIn?: unknown; zonesSearched: unknown[]; firewallEvents: unknown[] };
		};
		expect(result.foundIn).toBeUndefined();
		expect(result.zonesSearched).toHaveLength(2);
		expect(result.firewallEvents).toEqual([]);
	});

	it("searches only the requested zone when one is given", async () => {
		mockUpstream({ [ZONE_A]: { request: [{ rayName: RAY }] } });
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY, zoneId: ZONE_A })).json()) as {
			result: { zonesSearched: { id: string }[] };
		};
		expect(result.zonesSearched.map((z) => z.id)).toEqual([ZONE_A]);
	});

	it("names missing request fields only, not ones merely absent from the firewall row", async () => {
		// A union across datasets would call clientIP unavailable because firewall events lack
		// it here, while the request detail renders it fine.
		mockUpstream({ [ZONE_A]: { request: [{ rayName: RAY }] } });
		const { result } = (await (await trace({ accountId: ACCOUNT, rayId: RAY })).json()) as {
			result: { unavailableFields: string[] };
		};
		expect(result.unavailableFields).toContain("botScore");
		expect(result.unavailableFields).not.toContain("clientIP");
	});

	it("only selects fields the probe found, so an unknown field cannot break the query", async () => {
		mockUpstream({ [ZONE_A]: { request: [{ rayName: RAY }] } });
		await trace({ accountId: ACCOUNT, rayId: RAY });
		const traceQuery = graphqlQueries.find((q) => q.includes("RequestTrace")) ?? "";
		expect(traceQuery).toContain("clientIP");
		expect(traceQuery).not.toContain("botScore");
	});

	it("validates the ray, the account and the zone", async () => {
		expect((await trace({ accountId: ACCOUNT, rayId: "not-a-ray" })).status).toBe(400);
		expect((await trace({ accountId: "nope", rayId: RAY })).status).toBe(400);
		expect((await trace({ accountId: ACCOUNT, rayId: RAY, zoneId: "bad" })).status).toBe(400);
	});

	it("requires authentication", async () => {
		const res = await app.request(
			"/api/request/trace",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: ACCOUNT, rayId: RAY }) },
			ENV,
			ctx(),
		);
		expect(res.status).toBe(401);
	});
});

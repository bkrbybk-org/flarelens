import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_PAGES, isReadOnlyActivity, toAuditEvent } from "../src/lib/audit-log";

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const headers = { Authorization: "Bearer caller-token", "Content-Type": "application/json" };
const RANGE = { from: "2026-09-21T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Shaped like the live v2 events read on 2026-09-28 — IP and bodies included, as upstream sends them. */
function rawEvent(over: Record<string, unknown> = {}) {
	return {
		id: "ev-1",
		account: { id: ACCOUNT, name: "Example" },
		action: { type: "create", description: "Create DNS Record", result: "success", time: "2026-09-27T15:54:50.562Z" },
		actor: { type: "user", context: "dash", email: "admin@example.com", id: "u1", ip_address: "203.0.113.9" },
		resource: {
			product: "dns_records",
			scope: "zones",
			id: "rec1",
			type: "",
			request: { content: "203.0.113.50", name: "origin.example.com" },
			response: { secretish: "value" },
			value: { anything: true },
		},
		zone: { id: "z1", name: "example.com" },
		raw: { method: "POST", status_code: 200, uri: "/zones/z1/dns_records", cf_ray_id: "abc", user_agent: "Mozilla" },
		...over,
	};
}

const call = (body: unknown) => app.request("/api/audit/logs", { method: "POST", headers, body: JSON.stringify(body) }, ENV);

afterEach(() => vi.restoreAllMocks());

describe("toAuditEvent", () => {
	it("keeps who, what, where and the result", () => {
		expect(toAuditEvent(rawEvent())).toEqual({
			id: "ev-1",
			time: "2026-09-27T15:54:50.562Z",
			actionType: "create",
			description: "Create DNS Record",
			result: "success",
			actor: { type: "user", context: "dash", label: "admin@example.com" },
			resource: { product: "dns_records", type: "", id: "rec1", scope: "zones" },
			zone: { id: "z1", name: "example.com" },
			method: "POST",
			statusCode: 200,
			uri: "/zones/z1/dns_records",
			readOnly: false,
		});
	});

	it("never carries the actor's IP or the change's request and response bodies", () => {
		const serialized = JSON.stringify(toAuditEvent(rawEvent()));
		expect(serialized).not.toContain("203.0.113.9");
		expect(serialized).not.toContain("203.0.113.50");
		expect(serialized).not.toContain("secretish");
		expect(serialized).not.toContain("Mozilla");
	});

	it("labels an actor by token name, then type, when there is no email", () => {
		expect(toAuditEvent(rawEvent({ actor: { type: "account", context: "api_token", token: { id: "t1", name: "ci-deploy" } } })).actor.label).toBe("ci-deploy");
		expect(toAuditEvent(rawEvent({ actor: { type: "system" } })).actor.label).toBe("system");
	});

	it("flags dashboard analytics queries as read-only, and nothing else", () => {
		const query = toAuditEvent(rawEvent({ resource: { product: "analytics", type: "query.summary", scope: "accounts" } }));
		expect(query.readOnly).toBe(true);
		expect(isReadOnlyActivity({ resource: { product: "analytics", type: "settings", id: "", scope: "" } })).toBe(false);
		expect(isReadOnlyActivity({ resource: { product: "dns_records", type: "query", id: "", scope: "" } })).toBe(false);
	});
});

describe("POST /api/audit/logs", () => {
	it("reads every page until the cursor runs out, asking for newest first", async () => {
		const urls: string[] = [];
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			return url.includes("cursor=c1")
				? json({ success: true, result: [rawEvent({ id: "ev-2" })], result_info: { cursor: "" } })
				: json({ success: true, result: [rawEvent()], result_info: { cursor: "c1" } });
		}) as typeof fetch;
		const res = await call({ accountId: ACCOUNT, ...RANGE });
		expect(res.status).toBe(200);
		const { result } = (await res.json()) as { result: { events: { id: string }[]; truncated: boolean } };
		expect(result.events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
		expect(result.truncated).toBe(false);
		expect(urls[0]).toContain(`/accounts/${ACCOUNT}/logs/audit?`);
		expect(urls[0]).toContain("direction=desc");
		expect(urls[0]).toContain(`since=${encodeURIComponent(RANGE.from)}`);
	});

	it(`stops after ${MAX_PAGES} pages and says the window was truncated`, async () => {
		let n = 0;
		globalThis.fetch = vi.fn(async () => json({ success: true, result: [rawEvent({ id: `ev-${n++}` })], result_info: { cursor: `c${n}` } })) as typeof fetch;
		const { result } = (await (await call({ accountId: ACCOUNT, ...RANGE })).json()) as { result: { events: unknown[]; truncated: boolean } };
		expect(result.events).toHaveLength(MAX_PAGES);
		expect(result.truncated).toBe(true);
	});

	it("passes a permission refusal through as 403", async () => {
		globalThis.fetch = vi.fn(async () => json({ success: false, errors: [{ message: "Authentication error" }] }, 403)) as typeof fetch;
		const res = await call({ accountId: ACCOUNT, ...RANGE });
		expect(res.status).toBe(403);
	});

	it("validates the account and the window before calling Cloudflare", async () => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
		expect((await call({ accountId: "nope", ...RANGE })).status).toBe(400);
		expect((await call({ accountId: ACCOUNT, from: "yesterday", to: RANGE.to })).status).toBe(400);
		expect((await call({ accountId: ACCOUNT, from: RANGE.to, to: RANGE.from })).status).toBe(400);
		expect((await call({ accountId: ACCOUNT, from: "2026-08-01T00:00:00.000Z", to: RANGE.to })).status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

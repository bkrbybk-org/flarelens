import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

/**
 * Route cover for GET /api/tunnels/:tunnelId/metrics (src/routes/tunnels.ts). resolveAuth and the
 * account allowlist are covered generically in tests/routes-auth.test.ts; this file covers the
 * route's own logic: config lookup, account-ownership check, and that only parsed numbers — never
 * the configured URL — ever reach the client.
 */

const ACCOUNT = "11111111111111111111111111111111";
const TUNNEL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_TUNNEL_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const METRICS_URL = "https://metrics-secret-host.example.com/metrics";

const ENV_BASE = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token" };

function envWithConfig(configured: boolean) {
	return {
		...ENV_BASE,
		TUNNEL_METRICS: configured ? JSON.stringify([{ tunnelId: TUNNEL_ID, url: METRICS_URL }]) : undefined,
		METRICS_ACCESS_CLIENT_ID: "cid",
		METRICS_ACCESS_CLIENT_SECRET: "csecret",
	};
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("GET /api/tunnels/:tunnelId/metrics", () => {
	it("404s with no fetch at all when the tunnel id has no configured target", async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;
		const res = await app.request(`/api/tunnels/${OTHER_TUNNEL_ID}/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("400s on a malformed tunnelId", async () => {
		const res = await app.request(`/api/tunnels/not-a-uuid/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(400);
	});

	it("403s with no metrics fetch when the tunnel does not belong to this account", async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.includes(`/cfd_tunnel/${TUNNEL_ID}`)) return json({ success: false, errors: [{ message: "Not found" }] }, 404);
			if (url.includes("metrics-secret-host")) throw new Error("must not fetch metrics when account check fails");
			return json({ success: true, result: [] });
		}) as typeof fetch;
		const res = await app.request(`/api/tunnels/${TUNNEL_ID}/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(403);
	});

	it("treats a redirect from the metrics endpoint as an error", async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.includes(`/cfd_tunnel/${TUNNEL_ID}`)) return json({ success: true, result: { id: TUNNEL_ID } });
			if (url.includes("metrics-secret-host")) return new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login" } });
			return json({ success: true, result: [] });
		}) as typeof fetch;
		const res = await app.request(`/api/tunnels/${TUNNEL_ID}/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { errors: { message: string }[] };
		expect(body.errors[0].message).toMatch(/Access refused/);
	});

	it("errors on an oversize metrics body rather than buffering it", async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.includes(`/cfd_tunnel/${TUNNEL_ID}`)) return json({ success: true, result: { id: TUNNEL_ID } });
			if (url.includes("metrics-secret-host")) {
				const chunk = new Uint8Array(1024 * 1024);
				let sent = 0;
				const stream = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent >= 3) {
							controller.close();
							return;
						}
						sent++;
						controller.enqueue(chunk);
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/plain" } });
			}
			return json({ success: true, result: [] });
		}) as typeof fetch;
		const res = await app.request(`/api/tunnels/${TUNNEL_ID}/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(502);
	});

	it("happy path: parses numbers and never sends the configured URL to the client", async () => {
		globalThis.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			if (url.includes(`/cfd_tunnel/${TUNNEL_ID}`)) return json({ success: true, result: { id: TUNNEL_ID } });
			if (url.includes("metrics-secret-host")) {
				expect((init?.headers as Record<string, string>)["CF-Access-Client-Id"]).toBe("cid");
				return new Response("process_resident_memory_bytes 2048\ncloudflared_tunnel_ha_connections 4\n", {
					status: 200,
					headers: { "Content-Type": "text/plain" },
				});
			}
			return json({ success: true, result: [] });
		}) as typeof fetch;
		const res = await app.request(`/api/tunnels/${TUNNEL_ID}/metrics?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; result: { metrics: Record<string, number>; fetchedAt: string } };
		expect(body.result.metrics.processResidentMemoryBytes).toBe(2048);
		expect(body.result.metrics.haConnections).toBe(4);
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("metrics-secret-host");
		expect(raw).not.toContain("csecret");
	});
});

describe("GET /api/access/tunnels — hasMetricsTarget and latestCloudflared", () => {
	const list = (result: unknown[]) => ({ success: true, result, result_info: { total_pages: 1 } });

	beforeEach(() => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.includes("api.github.com")) {
				return json({ tag_name: "2026.9.1", published_at: "2026-09-01T00:00:00Z", prerelease: false });
			}
			if (url.includes("/cfd_tunnel/") && url.includes("/configurations")) return json({ success: true, result: { config: { ingress: [] } } });
			if (url.includes("/cfd_tunnel/") && url.includes("/connections")) return json(list([{ id: "c-1", version: "2026.6.0", conns: [] }]));
			if (url.includes("/cfd_tunnel")) return json(list([{ id: TUNNEL_ID, name: "T", status: "healthy" }]));
			if (url.includes("/teamnet/routes")) return json(list([]));
			if (url.includes("/workers/domains")) return json(list([]));
			if (url.includes("/access/apps")) return json(list([]));
			if (url.includes("/access/policies")) return json(list([]));
			return json(list([]));
		}) as typeof fetch;
	});
	afterEach(() => vi.restoreAllMocks());

	it("marks hasMetricsTarget per tunnel from TUNNEL_METRICS, and includes latestCloudflared", async () => {
		const res = await app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(true));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { tunnels: { id: string; hasMetricsTarget?: boolean; health: { message: string }[] }[]; latestCloudflared: unknown };
		};
		const tunnel = body.result.tunnels.find((t) => t.id === TUNNEL_ID);
		expect(tunnel?.hasMetricsTarget).toBe(true);
		expect(body.result.latestCloudflared).toEqual({ version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
		expect(tunnel?.health.some((h) => h.message.includes("latest is 2026.9.1"))).toBe(true);
	});

	it("is false when no target is configured for that tunnel", async () => {
		const res = await app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, { headers: auth }, envWithConfig(false));
		const body = (await res.json()) as { result: { tunnels: { id: string; hasMetricsTarget?: boolean }[] } };
		expect(body.result.tunnels.find((t) => t.id === TUNNEL_ID)?.hasMetricsTarget).toBe(false);
	});
});

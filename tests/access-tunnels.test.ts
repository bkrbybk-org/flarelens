import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

/** Cover for the Access app → tunnel → origin join, including the gaps it is meant to surface. */

const ACCOUNT = "11111111111111111111111111111111";
const ENV = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const auth = { Authorization: "Bearer caller-token" };

const list = (result: unknown[]) => ({ success: true, result, result_info: { total_pages: 1 } });

interface Upstream {
	apps?: unknown[];
	policies?: Record<string, unknown[]>;
	accountPolicies?: unknown[];
	tunnels?: unknown[];
	configs?: Record<string, unknown>;
	routes?: unknown[];
	tunnelStatus?: number;
}

function mockUpstream(u: Upstream) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

		if (url.includes("/cfd_tunnel/") && url.includes("/configurations")) {
			const id = url.split("/cfd_tunnel/")[1].split("/")[0];
			const config = (u.configs ?? {})[id];
			return config ? json({ success: true, result: config }) : json({ success: false, errors: [{ message: "nope" }] }, 404);
		}
		if (url.includes("/cfd_tunnel")) {
			if (u.tunnelStatus && u.tunnelStatus !== 200) {
				return json({ success: false, errors: [{ message: "Authentication error" }] }, u.tunnelStatus);
			}
			return json(list(u.tunnels ?? []));
		}
		if (url.includes("/teamnet/routes")) return json(list(u.routes ?? []));
		if (url.includes("/access/apps/") && url.includes("/policies")) {
			const id = url.split("/access/apps/")[1].split("/")[0];
			return json(list((u.policies ?? {})[id] ?? []));
		}
		if (url.includes("/access/apps")) return json(list(u.apps ?? []));
		if (url.includes("/access/policies")) return json(list(u.accountPolicies ?? []));
		return json(list([]));
	}) as typeof fetch;
}

const call = () => app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, { headers: auth }, ENV);

const gitlabApp = {
	id: "app-1",
	name: "gitlab-ce",
	type: "self_hosted",
	destinations: [{ type: "public", uri: "gitlab-ce.example.com" }],
};
const cwLab = { id: "t-1", name: "Tunnel A", status: "healthy", connections: [{ colo_name: "BKK" }] };

beforeEach(() =>
	mockUpstream({
		apps: [gitlabApp],
		policies: { "app-1": [{ id: "p-1", name: "Allow staff", decision: "allow" }] },
		tunnels: [cwLab],
		configs: {
			"t-1": { config: { ingress: [
				{ hostname: "gitlab-ce.example.com", service: "https://172.16.12.101:443" },
				{ service: "http_status:404" },
			] } },
		},
	}),
);
afterEach(() => vi.restoreAllMocks());

describe("the chain", () => {
	it("joins destination → policy → tunnel → origin", async () => {
		const { result } = (await (await call()).json()) as { result: { rows: Record<string, never>[] } };
		const row = result.rows.find((r) => (r as { hostname: string }).hostname === "gitlab-ce.example.com") as never as {
			service: string; tunnel: { name: string }; app: { name: string; policies: { name: string; decision: string }[] }; gap?: string;
		};
		expect(row.app.name).toBe("gitlab-ce");
		expect(row.app.policies).toEqual([{ name: "Allow staff", decision: "allow" }]);
		expect(row.tunnel.name).toBe("Tunnel A");
		expect(row.service).toBe("https://172.16.12.101:443");
		expect(row.gap).toBeUndefined();
	});

	it("keeps the catch-all rule but does not call it an ungated hostname", async () => {
		// The final `http_status:404` rule is plumbing, not an exposed origin.
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; gap?: string }[] } };
		const catchAll = result.rows.find((r) => r.hostname === "(catch-all)");
		expect(catchAll?.gap).toBeUndefined();
	});
});

describe("gaps", () => {
	it("flags a tunnel hostname with no Access application", async () => {
		mockUpstream({
			apps: [],
			tunnels: [cwLab],
			configs: { "t-1": { config: { ingress: [{ hostname: "wide-open.example.com", service: "http://10.0.0.5:80" }] } } },
		});
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; gap?: string }[] } };
		expect(result.rows.find((r) => r.hostname === "wide-open.example.com")?.gap).toBe("no-access-app");
	});

	it("flags an Access application no tunnel serves", async () => {
		mockUpstream({ apps: [gitlabApp], tunnels: [], configs: {} });
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; gap?: string }[] } };
		expect(result.rows.find((r) => r.hostname === "gitlab-ce.example.com")?.gap).toBe("no-tunnel");
	});

	it("matches a wildcard ingress rule against an app hostname", async () => {
		mockUpstream({
			apps: [gitlabApp],
			tunnels: [cwLab],
			configs: { "t-1": { config: { ingress: [{ hostname: "*.example.com", service: "https://172.16.12.101:443" }] } } },
		});
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; app?: { name: string } }[] } };
		expect(result.rows.find((r) => r.hostname === "*.example.com")?.app?.name).toBe("gitlab-ce");
	});
});

describe("degradation", () => {
	it("passes a tunnel-scope refusal through as 403 rather than an empty map", async () => {
		mockUpstream({ apps: [gitlabApp], tunnelStatus: 403 });
		expect((await call()).status).toBe(403);
	});

	it("reports a per-tunnel configuration failure without losing the tunnel", async () => {
		mockUpstream({ apps: [], tunnels: [cwLab], configs: {} });
		const { result } = (await (await call()).json()) as { result: { tunnels: { name: string; configError?: string }[] } };
		expect(result.tunnels[0].name).toBe("Tunnel A");
		expect(result.tunnels[0].configError).toBeTruthy();
	});

	it("resolves a reusable policy attached to an app by reference", async () => {
		mockUpstream({
			apps: [gitlabApp],
			policies: { "app-1": [{ id: "shared-1" }] },
			accountPolicies: [{ id: "shared-1", name: "Shared allow", decision: "allow", include: [] }],
			tunnels: [cwLab],
			configs: { "t-1": { config: { ingress: [{ hostname: "gitlab-ce.example.com", service: "https://172.16.12.101:443" }] } } },
		});
		const { result } = (await (await call()).json()) as { result: { rows: { app?: { policies: { name: string }[] } }[] } };
		expect(result.rows[0].app?.policies[0].name).toBe("Shared allow");
	});

	it("requires authentication and a valid account id", async () => {
		expect((await app.request(`/api/access/tunnels?account_id=${ACCOUNT}`, undefined, ENV)).status).toBe(401);
		expect((await app.request("/api/access/tunnels?account_id=nope", { headers: auth }, ENV)).status).toBe(400);
	});
});

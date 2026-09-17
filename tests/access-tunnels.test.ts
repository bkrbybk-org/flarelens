import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { tunnelHealth, type TunnelConnector } from "../src/lib/access-tunnels";

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
	/** Per tunnel id; a number is an HTTP error status. Absent means no connectors. */
	connectors?: Record<string, unknown[] | number>;
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
		if (url.includes("/cfd_tunnel/") && url.includes("/connections")) {
			const id = url.split("/cfd_tunnel/")[1].split("/")[0];
			const c = (u.connectors ?? {})[id] ?? [];
			return typeof c === "number"
				? json({ success: false, errors: [{ message: "Authentication error" }] }, c)
				: json({ success: true, result: c });
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
		const { result } = (await (await call()).json()) as { result: { rows: Record<string, unknown>[] } };
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

describe("origin kinds — not every app needs a tunnel", () => {
	const withType = (type: string, host: string, extra: Record<string, unknown> = {}) => ({
		id: `app-${type}-${host}`,
		name: `${type} app`,
		type,
		destinations: [{ type: "public", uri: host }],
		...extra,
	});

	it("treats Cloudflare-hosted application types as routed, not missing a tunnel", async () => {
		// WARP, App Launcher and Browser Isolation are served by Cloudflare on the team domain.
		// Flagging them as "no tunnel" would be noise on every account that uses them.
		mockUpstream({
			apps: [
				withType("warp", "team.cloudflareaccess.com/warp"),
				withType("app_launcher", "team.cloudflareaccess.com"),
				withType("biso", "team.cloudflareaccess.com/browser"),
			],
			tunnels: [],
		});
		const { result } = (await (await call()).json()) as { result: { rows: { originKind: string; gap?: string }[] } };
		expect(result.rows.map((r) => r.originKind)).toEqual(["cloudflare", "cloudflare", "cloudflare"]);
		expect(result.rows.every((r) => !r.gap)).toBe(true);
	});

	it("recognises a workers.dev hostname as a Worker origin", async () => {
		mockUpstream({ apps: [withType("self_hosted", "svc.example.workers.dev")], tunnels: [] });
		const { result } = (await (await call()).json()) as { result: { rows: { originKind: string; service: string; gap?: string }[] } };
		expect(result.rows[0].originKind).toBe("worker");
		expect(result.rows[0].service).toBe("Cloudflare Worker");
		expect(result.rows[0].gap).toBeUndefined();
	});

	it("lists private destinations that have no public hostname at all", async () => {
		// These were dropped entirely before: no hostname meant no row, so three private_ip
		// applications were simply invisible on the map.
		mockUpstream({
			apps: [{ id: "app-p", name: "OpenShift", type: "self_hosted", destinations: [{ type: "private", uri: "10.0.4.0/24" }] }],
			tunnels: [],
		});
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; originKind: string; gap?: string }[] } };
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].hostname).toBe("10.0.4.0/24");
		expect(result.rows[0].originKind).toBe("private");
		expect(result.rows[0].gap).toBeUndefined();
	});

	it("still flags a self-hosted public hostname with no route to an origin", async () => {
		mockUpstream({ apps: [withType("self_hosted", "orphan.example.com")], tunnels: [] });
		const { result } = (await (await call()).json()) as { result: { rows: { originKind: string; gap?: string }[] } };
		expect(result.rows[0].originKind).toBe("unknown");
		expect(result.rows[0].gap).toBe("no-tunnel");
	});

	it("marks a tunnel-served row as tunnel-routed", async () => {
		const { result } = (await (await call()).json()) as { result: { rows: { hostname: string; originKind: string }[] } };
		expect(result.rows.find((r) => r.hostname === "gitlab-ce.example.com")?.originKind).toBe("tunnel");
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

const connector = (id: string, version: string, colos: string[], pending = false) => ({
	id, version, arch: "linux_amd64", run_at: "2026-09-01T00:00:00Z", features: ["management_logs"],
	conns: colos.map((colo, i) => ({ id: `${id}-${i}`, colo_name: colo, opened_at: "2026-09-15T00:00:00Z", origin_ip: "203.0.113.7", is_pending_reconnect: pending && i === 0 })),
});

describe("connectors", () => {
	type Tunnel = { colos: string[]; connectors: TunnelConnector[]; connectorsError?: string; health: { level: string; message: string }[]; configSource?: string; activeSince?: string };
	const tunnelsOf = async () => ((await (await call()).json()) as { result: { tunnels: Tunnel[] } }).result.tunnels;

	it("reads connectors and their connections from the connections endpoint", async () => {
		mockUpstream({
			apps: [], configs: {},
			tunnels: [{ ...cwLab, connections: [{ colo_name: "STALE" }], config_src: "cloudflare", conns_active_at: "2026-09-01T00:00:00Z" }],
			connectors: { "t-1": [connector("c-1", "2026.6.0", ["sin18", "sin16", "sin18", "sin16"]), connector("c-2", "2026.6.1", ["bkk01", "sin16", "bkk01", "sin16"])] },
		});
		const [t] = await tunnelsOf();
		expect(t.connectors.map((c) => [c.id, c.version, c.connections.length])).toEqual([["c-1", "2026.6.0", 4], ["c-2", "2026.6.1", 4]]);
		expect(t.connectors[0].connections[0]).toMatchObject({ colo: "sin18", originIp: "203.0.113.7", pendingReconnect: false });
		// Colos come from the connectors, not the deprecated list field.
		expect(t.colos).toEqual(["bkk01", "sin16", "sin18"]);
		expect(t).toMatchObject({ configSource: "cloudflare", activeSince: "2026-09-01T00:00:00Z" });
		expect(t.health).toEqual([{ level: "info", message: "Connectors run different cloudflared versions (2026.6.0, 2026.6.1)." }]);
	});

	it("keeps a connectors failure distinct from no connectors, and falls back to the list's colos", async () => {
		mockUpstream({ apps: [], configs: {}, tunnels: [cwLab], connectors: { "t-1": 403 } });
		const [t] = await tunnelsOf();
		expect(t.connectors).toEqual([]);
		expect(t.connectorsError).toBe("Authentication error");
		expect(t.health).toEqual([]);
		expect(t.colos).toEqual(["BKK"]);
	});
});

describe("tunnelHealth", () => {
	const c = (id: string, version: string, live: number, pending = 0): TunnelConnector => ({
		id, version, arch: "linux_amd64", features: [],
		connections: [
			...Array.from({ length: live }, (_, i) => ({ id: `${id}${i}`, colo: "sin", pendingReconnect: false })),
			...Array.from({ length: pending }, (_, i) => ({ id: `${id}p${i}`, colo: "sin", pendingReconnect: true })),
		],
	});

	it("says nothing for two full, same-version connectors", () => {
		expect(tunnelHealth("healthy", [c("aaaaaaaa1", "1", 4), c("bbbbbbbb1", "1", 4)])).toEqual([]);
	});

	it("flags a single connector as having no redundancy", () => {
		expect(tunnelHealth("healthy", [c("aaaaaaaa1", "1", 4)]).map((n) => n.level)).toEqual(["warn"]);
	});

	it("flags missing and reconnecting connections per connector", () => {
		const messages = tunnelHealth("degraded", [c("aaaaaaaa1", "1", 3, 1), c("bbbbbbbb1", "1", 4)]).map((n) => n.message);
		expect(messages).toEqual([
			"Connector aaaaaaaa has a connection waiting to reconnect.",
			"Connector aaaaaaaa holds 3 of 4 edge connections.",
		]);
	});

	it("warns when a down tunnel has no connector, but not for an inactive one", () => {
		expect(tunnelHealth("down", [])).toHaveLength(1);
		expect(tunnelHealth("inactive", [])).toEqual([]);
	});

	it("draws no conclusion from connectors it could not read", () => {
		expect(tunnelHealth("down", [], "Authentication error")).toEqual([]);
	});
});

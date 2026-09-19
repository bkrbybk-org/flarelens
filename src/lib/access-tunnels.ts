/**
 * Access application → Cloudflare Tunnel → origin mapping.
 *
 * Answers the question an auditor actually asks about a self-hosted app: a request for
 * `gitlab-ce.example.com` is gated by which Access policy, carried by which tunnel, and lands on
 * which origin? Each half is visible in the Cloudflare dashboard, but never on one screen, and
 * the interesting cases are the mismatches — a tunnel ingress with no Access app in front of it,
 * or an Access app whose hostname no tunnel serves.
 *
 * Every source is fetched independently and its failure recorded rather than thrown, because the
 * scopes differ: a token can read Access and not Tunnels, and a partial map is still useful.
 */

import { CF_API_BASE as REST_BASE, authHeaders, mapWithConcurrency, restList } from "./cf-rest";

export class TunnelMapError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "TunnelMapError";
	}
}




interface CfTunnel {
	id: string;
	name?: string;
	status?: string;
	deleted_at?: string | null;
	created_at?: string;
	conns_active_at?: string | null;
	conns_inactive_at?: string | null;
	/** "cloudflare" when ingress is managed from the dashboard, "local" when from a config file. */
	config_src?: string;
	remote_config?: boolean;
	/** Deprecated by Cloudflare (2026-07-09) in favour of `/connections`; read only as a fallback. */
	connections?: { colo_name?: string }[];
}

/** One `cloudflared` process, as `GET /cfd_tunnel/{id}/connections` returns it. */
interface CfConnector {
	id?: string;
	version?: string;
	arch?: string;
	run_at?: string;
	features?: string[];
	conns?: {
		id?: string;
		colo_name?: string;
		opened_at?: string;
		origin_ip?: string;
		is_pending_reconnect?: boolean;
	}[];
}

export interface TunnelConnection {
	id: string;
	colo: string;
	openedAt?: string;
	/** Public address the connector dialled out from — the host's egress IP, not the origin service. */
	originIp?: string;
	pendingReconnect: boolean;
}

export interface TunnelConnector {
	id: string;
	version: string;
	arch: string;
	/** When this `cloudflared` process started. */
	startedAt?: string;
	features: string[];
	connections: TunnelConnection[];
}

export interface TunnelHealthNote {
	level: "warn" | "info";
	message: string;
}

/** `cloudflared` opens four connections to the edge; fewer means some are down or still dialling. */
export const EXPECTED_CONNECTIONS_PER_CONNECTOR = 4;

interface CfIngressRule {
	hostname?: string;
	path?: string;
	service?: string;
	originRequest?: Record<string, unknown>;
}

interface CfWorkerDomain {
	hostname?: string;
	service?: string;
}

interface CfRoute {
	network?: string;
	tunnel_id?: string;
	comment?: string;
	virtual_network_id?: string;
}

export interface TunnelSummary {
	id: string;
	name: string;
	status: string;
	/** Colos the tunnel is currently connected through; empty means no live connection. */
	colos: string[];
	/** Ingress rules could not be read for this tunnel. */
	configError?: string;
	createdAt?: string;
	/** When the tunnel last went from no connections to some. */
	activeSince?: string;
	/** When the tunnel last lost its final connection. */
	inactiveSince?: string;
	/** Where ingress is configured: "cloudflare" (dashboard/API) or "local" (config file). */
	configSource?: string;
	connectors: TunnelConnector[];
	/** Connectors could not be read; `connectors` is then empty for that reason, not because none run. */
	connectorsError?: string;
	health: TunnelHealthNote[];
	/**
	 * Whether a `TUNNEL_METRICS` target is configured for this tunnel — never the URL itself.
	 * Set by the route after `fetchTunnelMap` resolves (config is deploy-time, not part of the
	 * Cloudflare read), so it is optional here.
	 */
	hasMetricsTarget?: boolean;
}

function toConnector(raw: CfConnector): TunnelConnector {
	return {
		id: raw.id || "",
		version: raw.version || "unknown",
		arch: raw.arch || "unknown",
		startedAt: raw.run_at || undefined,
		features: raw.features || [],
		connections: (raw.conns || []).map((c) => ({
			id: c.id || "",
			colo: c.colo_name || "unknown",
			openedAt: c.opened_at || undefined,
			originIp: c.origin_ip || undefined,
			pendingReconnect: c.is_pending_reconnect === true,
		})),
	};
}

/**
 * What an operator should know about a tunnel's connectors, from what the API reports.
 *
 * Nothing here is said when the connectors could not be read: an unread list is not an empty
 * one, and "no redundancy" from a failed fetch would be a false finding.
 */
export function tunnelHealth(status: string, connectors: TunnelConnector[], connectorsError?: string): TunnelHealthNote[] {
	if (connectorsError) return [];
	const notes: TunnelHealthNote[] = [];
	const s = status.toLowerCase();
	if (connectors.length === 0) {
		if (s !== "inactive") notes.push({ level: "warn", message: "No connector is running, so nothing this tunnel routes is reachable." });
		return notes;
	}
	if (connectors.length === 1) {
		notes.push({
			level: "warn",
			message: "Only one connector is running — no redundancy. Restarting or losing that host takes every route on this tunnel down.",
		});
	}
	const versions = [...new Set(connectors.map((c) => c.version))];
	if (versions.length > 1) {
		notes.push({ level: "info", message: `Connectors run different cloudflared versions (${versions.sort().join(", ")}).` });
	}
	for (const connector of connectors) {
		const label = connector.id.slice(0, 8) || "a connector";
		const live = connector.connections.filter((c) => !c.pendingReconnect).length;
		if (connector.connections.some((c) => c.pendingReconnect)) {
			notes.push({ level: "warn", message: `Connector ${label} has a connection waiting to reconnect.` });
		}
		if (live < EXPECTED_CONNECTIONS_PER_CONNECTOR) {
			notes.push({
				level: "warn",
				message: `Connector ${label} holds ${live} of ${EXPECTED_CONNECTIONS_PER_CONNECTOR} edge connections.`,
			});
		}
	}
	return notes;
}

/**
 * Where a destination's traffic actually terminates.
 *
 * Not every Access application needs a tunnel, so "no ingress rule matched" is only a finding for
 * the kinds that should have one. A WARP or App Launcher app is served by Cloudflare itself, a
 * `.workers.dev` hostname is a Worker, and a private destination is reached over the private
 * network rather than a public hostname.
 */
export type OriginKind = "tunnel" | "worker" | "cloudflare" | "private" | "unknown";

export interface MappingRow {
	/** Public hostname, or the catch-all marker for a tunnel's final rule. */
	hostname: string;
	path?: string;
	/** Origin the tunnel forwards to, e.g. `https://172.16.12.101:443`. */
	service: string;
	tunnel?: { id: string; name: string; status: string };
	originKind: OriginKind;
	app?: {
		id: string;
		name: string;
		type?: string;
		policies: { name: string; decision: string }[];
		policiesError: boolean;
	};
	/**
	 * What is missing, if anything: a tunnel ingress nobody gates, or a destination that should
	 * reach an origin and has no visible route to one. Kinds that legitimately have no tunnel
	 * never raise the second.
	 */
	gap?: "no-access-app" | "no-tunnel";
}

export interface PrivateRoute {
	network: string;
	tunnelName: string;
	tunnelId: string;
	comment?: string;
}

export interface TunnelMapResult {
	tunnels: TunnelSummary[];
	rows: MappingRow[];
	privateRoutes: PrivateRoute[];
	/** Per-source failures, so a partial map states what is missing rather than looking complete. */
	errors: { source: string; message: string }[];
	/** The latest cloudflared GitHub release, for version comparison. Set by the route, not this fetch. */
	latestCloudflared?: { version: string; publishedAt: string } | { error: string };
}

/** Cloudflare writes a tunnel's final catch-all rule with no hostname. */
const CATCH_ALL = "(catch-all)";

function normaliseHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "").replace(/^https?:\/\//, "").split("/")[0];
}

/** `*.example.com` in an ingress rule matches any single-label subdomain. */
function hostMatches(ingressHost: string, appHost: string): boolean {
	if (ingressHost === appHost) return true;
	if (ingressHost.startsWith("*.")) {
		const suffix = ingressHost.slice(1);
		return appHost.endsWith(suffix) && appHost.slice(0, -suffix.length).length > 0;
	}
	return false;
}

/** Application types Cloudflare serves itself; a tunnel would make no sense for them. */
const CLOUDFLARE_HOSTED_TYPES = new Set(["warp", "app_launcher", "biso", "dash_sso"]);
/** Types whose origin is a third party, not an origin of ours. */
const EXTERNAL_TYPES = new Set(["saas", "bookmark"]);

interface AccessApp {
	id: string;
	name?: string;
	type?: string;
	domain?: string;
	self_hosted_domains?: string[];
	destinations?: { type?: string; uri?: string }[];
	policies?: { name?: string; decision?: string }[];
	policies_error?: boolean;
}

/** Every public hostname an Access app claims, from whichever field the app model uses. */
function appHostnames(app: AccessApp): string[] {
	const hosts = new Set<string>();
	for (const destination of app.destinations || []) {
		if (destination.type === "public" && destination.uri) hosts.add(normaliseHost(destination.uri));
	}
	for (const domain of app.self_hosted_domains || []) hosts.add(normaliseHost(domain));
	if (app.domain) hosts.add(normaliseHost(app.domain));
	return [...hosts].filter(Boolean);
}

/** A `.workers.dev` hostname is served by a Worker; no tunnel is involved. */
function isWorkersDev(host: string): boolean {
	return host.endsWith(".workers.dev");
}

function originKindFor(app: AccessApp, host: string, workerDomains: Map<string, string>): OriginKind {
	if (isWorkersDev(host) || workerDomains.has(host)) return "worker";
	if (app.type && CLOUDFLARE_HOSTED_TYPES.has(app.type)) return "cloudflare";
	if (app.type && EXTERNAL_TYPES.has(app.type)) return "cloudflare";
	if (app.type === "private_ip") return "private";
	return "unknown";
}

function originLabel(kind: OriginKind): string {
	switch (kind) {
		case "worker":
			return "Cloudflare Worker";
		case "cloudflare":
			return "Cloudflare-hosted";
		case "private":
			return "private network";
		default:
			return "—";
	}
}

/**
 * `apps` arrives as a promise on purpose.
 *
 * None of the tunnel-side fetches depend on the Access applications — the applications are only
 * needed at the end, to join each ingress hostname to the app that gates it. Taking the resolved
 * array would make the caller wait for the applications before this function could start, which
 * is a round trip of wall clock spent on an ordering accident.
 */
async function readConfig(url: string, token: string): Promise<{ ingress: CfIngressRule[]; error?: string }> {
	const response = await fetch(url, { headers: authHeaders(token) });
	let body: { success?: boolean; result?: { config?: { ingress?: CfIngressRule[] } }; errors?: { message?: string }[] };
	try {
		body = await response.json();
	} catch {
		return { ingress: [], error: "Non-JSON configuration response" };
	}
	if (!response.ok || !body.success) {
		return { ingress: [], error: body.errors?.[0]?.message || `HTTP ${response.status}` };
	}
	return { ingress: body.result?.config?.ingress || [] };
}

async function readConnectors(url: string, token: string): Promise<{ connectors: TunnelConnector[]; connectorsError?: string }> {
	const response = await fetch(url, { headers: authHeaders(token) });
	let body: { success?: boolean; result?: CfConnector[]; errors?: { message?: string }[] };
	try {
		body = await response.json();
	} catch {
		return { connectors: [], connectorsError: "Non-JSON connections response" };
	}
	if (!response.ok || !body.success) {
		return { connectors: [], connectorsError: body.errors?.[0]?.message || `HTTP ${response.status}` };
	}
	return { connectors: (body.result || []).map(toConnector) };
}

export async function fetchTunnelMap(
	accountId: string,
	token: string,
	appsPromise: AccessApp[] | Promise<AccessApp[]>,
): Promise<TunnelMapResult> {
	const errors: { source: string; message: string }[] = [];

	const tunnelsRes = await restList<CfTunnel>(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`, token);
	if (tunnelsRes.error) {
		// 401/403 here is the common case: the token lacks Cloudflare Tunnel: Read.
		if (tunnelsRes.status === 401 || tunnelsRes.status === 403) {
			throw new TunnelMapError(tunnelsRes.error, tunnelsRes.status);
		}
		errors.push({ source: "tunnels", message: tunnelsRes.error });
	}

	const tunnels = tunnelsRes.result.filter((t) => !t.deleted_at);

	// The tunnel configurations, the private routes and the Worker domains depend on nothing but
	// the tunnel list, so they go out together. Run one after another they cost three round trips
	// of wall clock for no reason — the later two were waiting only because they were written
	// after the loop.
	const [configs, routesRes, domainsRes] = await Promise.all([
		mapWithConcurrency(tunnels, 5, async (tunnel) => {
			const base = `${REST_BASE}/accounts/${accountId}/cfd_tunnel/${tunnel.id}`;
			// Configuration and connectors are independent reads of the same tunnel.
			const [config, connectors] = await Promise.all([readConfig(`${base}/configurations`, token), readConnectors(`${base}/connections`, token)]);
			return { tunnel, ...config, ...connectors };
		}),
		restList<CfRoute>(`/accounts/${accountId}/teamnet/routes`, token),
		// Worker custom domains, so an app served by a Worker on its own hostname is identified
		// as such rather than reported as missing a tunnel. Best-effort: this needs Workers
		// Scripts: Read, and without it those rows stay unclassified instead of the map failing.
		restList<CfWorkerDomain>(`/accounts/${accountId}/workers/domains`, token),
	]);

	if (routesRes.error) errors.push({ source: "private routes", message: routesRes.error });

	const workerDomains = new Map<string, string>();
	for (const domain of domainsRes.result) {
		if (domain.hostname) workerDomains.set(normaliseHost(domain.hostname), domain.service || "Worker");
	}

	const summaries: TunnelSummary[] = configs.map(({ tunnel, error, connectors, connectorsError }) => {
		const status = tunnel.status || "unknown";
		// Colos come from the connectors; the list's own `connections` field is deprecated and is
		// only read when the connectors could not be.
		const colos = connectorsError
			? (tunnel.connections || []).map((c) => c.colo_name)
			: connectors.flatMap((c) => c.connections.filter((conn) => !conn.pendingReconnect).map((conn) => conn.colo));
		return {
			id: tunnel.id,
			name: tunnel.name || tunnel.id,
			status,
			colos: [...new Set(colos.filter((c): c is string => !!c && c !== "unknown"))].sort(),
			configError: error,
			createdAt: tunnel.created_at || undefined,
			activeSince: tunnel.conns_active_at || undefined,
			inactiveSince: tunnel.conns_inactive_at || undefined,
			configSource: tunnel.config_src || (tunnel.remote_config === true ? "cloudflare" : tunnel.remote_config === false ? "local" : undefined),
			connectors,
			connectorsError,
			health: tunnelHealth(status, connectors, connectorsError),
		};
	});

	const apps = await appsPromise;

	// Index apps by hostname so each ingress rule can find its gate in one pass.
	const appsByHost = new Map<string, AccessApp>();
	for (const app of apps) {
		for (const host of appHostnames(app)) if (!appsByHost.has(host)) appsByHost.set(host, app);
	}

	const toAppRef = (app: AccessApp) => ({
		id: app.id,
		name: app.name || app.id,
		type: app.type,
		policies: (app.policies || []).map((p) => ({ name: p.name || "(unnamed)", decision: p.decision || "unknown" })),
		policiesError: !!app.policies_error,
	});

	const rows: MappingRow[] = [];
	const matchedAppIds = new Set<string>();

	for (const { tunnel, ingress } of configs) {
		for (const rule of ingress) {
			const host = rule.hostname ? normaliseHost(rule.hostname) : "";
			// A rule with no service is not routing anything; skip rather than render a blank row.
			if (!rule.service) continue;

			let app: AccessApp | undefined;
			if (host) {
				app = appsByHost.get(host);
				if (!app) {
					for (const [candidate, value] of appsByHost) {
						if (hostMatches(host, candidate)) {
							app = value;
							break;
						}
					}
				}
			}
			if (app) matchedAppIds.add(app.id);

			rows.push({
				hostname: host || CATCH_ALL,
				path: rule.path || undefined,
				service: rule.service,
				tunnel: { id: tunnel.id, name: tunnel.name || tunnel.id, status: tunnel.status || "unknown" },
				originKind: "tunnel",
				app: app ? toAppRef(app) : undefined,
				// The catch-all rule is plumbing, not an exposed hostname, so it is not a gap.
				gap: !app && host ? "no-access-app" : undefined,
			});
		}
	}

	// Access apps no tunnel ingress serves. Whether that is a finding depends entirely on the
	// application type: most of these are working exactly as intended.
	for (const app of apps) {
		if (matchedAppIds.has(app.id)) continue;
		const appRef = toAppRef(app);

		// Private destinations are reached over the private network, not a public hostname, so
		// they are listed by destination rather than dropped for having no hostname.
		for (const destination of app.destinations || []) {
			if (destination.type === "public" || !destination.uri) continue;
			rows.push({
				hostname: destination.uri,
				service: destination.uri,
				originKind: "private",
				app: appRef,
			});
		}

		for (const host of appHostnames(app)) {
			const kind = originKindFor(app, host, workerDomains);
			const worker = workerDomains.get(host);
			rows.push({
				hostname: host,
				service: worker ? `Worker: ${worker}` : originLabel(kind),
				originKind: kind,
				app: appRef,
				// Only a destination that ought to reach an origin of ours counts as a gap.
				gap: kind === "unknown" ? "no-tunnel" : undefined,
			});
		}
	}

	rows.sort((a, b) => a.hostname.localeCompare(b.hostname) || a.service.localeCompare(b.service));

	const tunnelNames = new Map(summaries.map((t) => [t.id, t.name]));
	const privateRoutes: PrivateRoute[] = routesRes.result
		.filter((r) => r.network && r.tunnel_id)
		.map((r) => ({
			network: r.network as string,
			tunnelId: r.tunnel_id as string,
			tunnelName: tunnelNames.get(r.tunnel_id as string) || (r.tunnel_id as string),
			comment: r.comment || undefined,
		}));

	return { tunnels: summaries, rows, privateRoutes, errors };
}

export interface TunnelConnection {
	id: string;
	colo: string;
	openedAt?: string;
	originIp?: string;
	pendingReconnect: boolean;
}

export interface TunnelConnector {
	id: string;
	version: string;
	arch: string;
	startedAt?: string;
	features: string[];
	connections: TunnelConnection[];
}

export interface TunnelSummary {
	id: string;
	name: string;
	status: string;
	colos: string[];
	configError?: string;
	createdAt?: string;
	activeSince?: string;
	inactiveSince?: string;
	configSource?: string;
	connectors: TunnelConnector[];
	connectorsError?: string;
	health: { level: "warn" | "info"; message: string }[];
	/** Whether a metrics target is configured server-side for this tunnel — never the URL itself. */
	hasMetricsTarget?: boolean;
}

/** The latest cloudflared GitHub release, or why it could not be determined. */
export type LatestCloudflared = { version: string; publishedAt: string } | { error: string };

export interface TunnelMetrics {
	processCpuSecondsTotal?: number;
	processResidentMemoryBytes?: number;
	processStartTimeSeconds?: number;
	haConnections?: number;
	totalRequests?: number;
	requestErrors?: number;
	concurrentRequests?: number;
}

export type OriginKind = "tunnel" | "worker" | "cloudflare" | "private" | "unknown";

export interface MappingRow {
	hostname: string;
	path?: string;
	service: string;
	originKind: OriginKind;
	tunnel?: { id: string; name: string; status: string };
	app?: {
		id: string;
		name: string;
		type?: string;
		policies: { name: string; decision: string }[];
		policiesError: boolean;
	};
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
	errors: { source: string; message: string }[];
	latestCloudflared?: LatestCloudflared;
}

/** Text for the CSV export and the search haystack — the chain as it reads on screen. */
export function chainText(row: MappingRow): string {
	const policies = row.app ? row.app.policies.map((p) => `${p.name} (${p.decision})`).join("; ") : "";
	return [row.hostname, row.app?.name ?? "", row.app?.type ?? "", policies, row.tunnel?.name ?? "", row.service].join(" ");
}

/** Cloudflare's application type as an operator would say it. */
export const APP_TYPE_LABELS: Record<string, string> = {
	self_hosted: "Self-hosted",
	private_ip: "Private IP",
	saas: "SaaS",
	ssh: "SSH",
	rdp: "RDP",
	vnc: "VNC",
	warp: "WARP",
	biso: "Browser isolation",
	app_launcher: "App Launcher",
	dash_sso: "Dashboard SSO",
	bookmark: "Bookmark",
	infrastructure: "Infrastructure",
};

export function appTypeLabel(type: string | undefined): string {
	if (!type) return "—";
	return APP_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

/**
 * How an origin kind should read. Only `unknown` is a finding: everything else is a destination
 * that legitimately never involves a tunnel.
 */
export function originKindLabel(kind: OriginKind): string {
	switch (kind) {
		case "tunnel":
			return "Tunnel";
		case "worker":
			return "Worker";
		case "cloudflare":
			return "Cloudflare";
		case "private":
			return "Private network";
		default:
			return "Unrouted";
	}
}

export function statusTone(status: string): string {
	const s = status.toLowerCase();
	if (s === "healthy" || s === "active") return "text-emerald-600 dark:text-emerald-400";
	if (s === "degraded" || s === "inactive") return "text-amber-600 dark:text-amber-400";
	if (s === "down") return "text-red-600 dark:text-red-400";
	return "text-zinc-500 dark:text-zinc-400";
}

export interface TunnelSummary {
	id: string;
	name: string;
	status: string;
	colos: string[];
	configError?: string;
}

export interface MappingRow {
	hostname: string;
	path?: string;
	service: string;
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
}

/** Text for the CSV export and the search haystack — the chain as it reads on screen. */
export function chainText(row: MappingRow): string {
	const policies = row.app ? row.app.policies.map((p) => `${p.name} (${p.decision})`).join("; ") : "";
	return [row.hostname, row.app?.name ?? "", policies, row.tunnel?.name ?? "", row.service].join(" ");
}

export function statusTone(status: string): string {
	const s = status.toLowerCase();
	if (s === "healthy" || s === "active") return "text-emerald-600 dark:text-emerald-400";
	if (s === "degraded" || s === "inactive") return "text-amber-600 dark:text-amber-400";
	if (s === "down") return "text-red-600 dark:text-red-400";
	return "text-zinc-500 dark:text-zinc-400";
}

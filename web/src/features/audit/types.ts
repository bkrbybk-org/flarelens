/** Mirrors AuditEvent / AuditLogResult in src/lib/audit-log.ts. */
export interface AuditEvent {
	id: string;
	time: string;
	actionType: string;
	description: string;
	result: string;
	actor: { type: string; context: string; label: string };
	resource: { product: string; type: string; id: string; scope: string };
	zone?: { id: string; name: string };
	method: string;
	statusCode: number | null;
	uri: string;
	readOnly: boolean;
}

export interface AuditLogResult {
	events: AuditEvent[];
	truncated: boolean;
	window: { since: string; until: string };
}

/** Cloudflare's own name for how a change arrived, in words. */
export function contextLabel(context: string): string {
	switch (context) {
		case "dash":
			return "Dashboard";
		case "api_token":
			return "API token";
		case "api_key":
			return "API key";
		case "oauth":
			return "OAuth (e.g. Wrangler)";
		case "origin_ca_key":
			return "Origin CA key";
		case "api":
			return "API";
		default:
			return context || "—";
	}
}

export interface AuditSummary {
	changes: number;
	failures: number;
	actors: number;
	deletes: number;
	byProduct: [string, number][];
	byActor: [string, number][];
}

export function summarise(events: AuditEvent[]): AuditSummary {
	const products = new Map<string, number>();
	const actors = new Map<string, number>();
	let failures = 0;
	let deletes = 0;
	for (const e of events) {
		products.set(e.resource.product || "—", (products.get(e.resource.product || "—") ?? 0) + 1);
		actors.set(e.actor.label, (actors.get(e.actor.label) ?? 0) + 1);
		if (e.result === "failure") failures++;
		if (e.actionType === "delete") deletes++;
	}
	const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return { changes: events.length, failures, actors: actors.size, deletes, byProduct: top(products), byActor: top(actors) };
}

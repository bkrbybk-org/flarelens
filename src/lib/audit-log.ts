/**
 * Account audit log: who changed what, when, and whether it worked.
 *
 * Reads Cloudflare's v2 audit log (`GET /accounts/{id}/logs/audit`), which needs only the
 * Account Settings: Read scope this app already requires. The endpoint is cursor-paginated at up
 * to 1,000 events a page; a busy account writes more than that in a week, so reads stop at
 * {@link MAX_PAGES} pages and say so rather than presenting a partial week as a whole one.
 *
 * **What is deliberately not returned.** Each upstream event carries the actor's IP address and the
 * request and response bodies of the change. The IP is personal data this review does not need, and
 * a body can carry configuration values — so neither leaves the Worker. What an audit review needs
 * stays: the actor's identity (email, or token name), the action, the resource, the zone, the
 * result and the request line.
 * https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/
 */

import { CF_API_BASE, authHeaders, upstreamFetch } from "./cf-rest";

export const MAX_AUDIT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
export const MAX_PAGES = 5;

export class AuditLogError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "AuditLogError";
	}
}

/** The upstream event, only as far as this module reads it. */
interface CfAuditEvent {
	id?: string;
	action?: { type?: string; description?: string; result?: string; time?: string };
	actor?: {
		type?: string;
		context?: string;
		email?: string;
		id?: string;
		token?: { id?: string; name?: string };
	};
	resource?: { product?: string; type?: string; id?: string; scope?: string };
	zone?: { id?: string; name?: string } | null;
	raw?: { method?: string; status_code?: number; uri?: string };
}

export interface AuditEvent {
	id: string;
	time: string;
	/** create, update, delete — Cloudflare's own classification of the request. */
	actionType: string;
	description: string;
	/** "success" or "failure". */
	result: string;
	actor: {
		/** user, account, system, delegated_service, cloudflare_admin. */
		type: string;
		/** dash, api_token, oauth, … — how the change arrived. */
		context: string;
		/** Who, as readably as the event allows: email, else token name, else the actor type. */
		label: string;
	};
	resource: { product: string; type: string; id: string; scope: string };
	zone?: { id: string; name: string };
	method: string;
	statusCode: number | null;
	uri: string;
	/** A read the audit log records as a create — see {@link isReadOnlyActivity}. */
	readOnly: boolean;
}

export interface AuditLogResult {
	events: AuditEvent[];
	/** More events existed in the window than {@link MAX_PAGES} pages hold. */
	truncated: boolean;
	window: { since: string; until: string };
}

/**
 * Activity the audit log files as a `create` although nothing changed. The dashboard's analytics
 * pages POST their queries, and each one is logged ("Query analytics summary") — on the account
 * this was built against they were 179 of 1,000 events in a week. Kept as a named list rather than
 * guessed from the method, so a real change is never hidden because it happens to be a POST.
 */
export function isReadOnlyActivity(event: Pick<AuditEvent, "resource">): boolean {
	return event.resource.product === "analytics" && event.resource.type.startsWith("query");
}

export function toAuditEvent(raw: CfAuditEvent): AuditEvent {
	const actor = raw.actor ?? {};
	const resource = {
		product: raw.resource?.product || "",
		type: raw.resource?.type || "",
		id: raw.resource?.id || "",
		scope: raw.resource?.scope || "",
	};
	const event: AuditEvent = {
		id: raw.id || "",
		time: raw.action?.time || "",
		actionType: raw.action?.type || "",
		description: raw.action?.description || "",
		result: raw.action?.result || "",
		actor: {
			type: actor.type || "",
			context: actor.context || "",
			label: actor.email || actor.token?.name || actor.type || "unknown",
		},
		resource,
		zone: raw.zone?.id ? { id: raw.zone.id, name: raw.zone.name || raw.zone.id } : undefined,
		method: raw.raw?.method || "",
		statusCode: typeof raw.raw?.status_code === "number" ? raw.raw.status_code : null,
		uri: raw.raw?.uri || "",
		readOnly: false,
	};
	event.readOnly = isReadOnlyActivity(event);
	return event;
}

export async function fetchAuditLog(accountId: string, token: string, since: string, until: string): Promise<AuditLogResult> {
	const events: AuditEvent[] = [];
	let cursor: string | undefined;
	let truncated = false;

	for (let page = 0; page < MAX_PAGES; page++) {
		const params = new URLSearchParams({ since, before: until, limit: String(PAGE_LIMIT), direction: "desc" });
		if (cursor) params.set("cursor", cursor);
		const response = await upstreamFetch(`${CF_API_BASE}/accounts/${accountId}/logs/audit?${params}`, { headers: authHeaders(token) });
		let body: { success?: boolean; result?: CfAuditEvent[]; errors?: { message?: string }[]; result_info?: { cursor?: string } };
		try {
			body = await response.json();
		} catch {
			throw new AuditLogError("Cloudflare returned a non-JSON audit log response", 502);
		}
		if (!response.ok || !body.success) {
			const message = body.errors?.[0]?.message || `HTTP ${response.status}`;
			// Pass refusals through as themselves: a 403 here means the token cannot read the log.
			throw new AuditLogError(message, response.status === 401 || response.status === 403 ? response.status : 502);
		}
		events.push(...(body.result ?? []).map(toAuditEvent));
		cursor = body.result_info?.cursor || undefined;
		if (!cursor || (body.result ?? []).length === 0) break;
		if (page === MAX_PAGES - 1) truncated = true;
	}

	return { events, truncated, window: { since, until } };
}

/**
 * AI Gateway configuration and refusals, from the REST API (needs **AI Gateway: Read**):
 *
 * - each gateway's settings — Guardrails categories and their actions, DLP policies, cache,
 *   rate limit, logging, spend limits — trimmed to what explains its traffic;
 * - each dynamic route's active version, as readable steps: what it checks, which models it can
 *   send to, and what it falls back to. The logs record a routed request under the route's name
 *   (`dynamic/<route>`), not the model that answered, so this says where a route *can* go;
 * - the window's failed and refused requests from the Logs API, with why: the Guardrails
 *   categories that blocked them, a DLP block, a rate limit, a payment refusal;
 * - what Guardrails and DLP flagged on requests they let through, from a bounded scan of the
 *   window's successful logs, which says how much of them it read.
 *
 * Both log reads follow the page's slice, with the API's own filters: a user is matched on the
 * `user` metadata key by Cloudflare, so no metadata has to be read here to do it.
 *
 * Log entries carry the prompt and the answer (`request`, `response`) and the caller's metadata.
 * None of those is read past parsing: every log is reduced to named fields here, before anything
 * leaves the Worker.
 */

import { CF_API_BASE, authHeaders, mapWithConcurrency, upstreamFetch } from "./cf-rest";

/** The Guardrails hazard categories, as the docs name them (Llama Guard 3's S1–S14, and prompt injection). */
export const GUARDRAIL_CATEGORIES: Record<string, string> = {
	S1: "Violent Crimes",
	S2: "Non-Violent Crimes",
	S3: "Sex-Related Crimes",
	S4: "Child Sexual Exploitation",
	S5: "Defamation",
	S6: "Specialized Advice",
	S7: "Privacy",
	S8: "Intellectual Property",
	S9: "Indiscriminate Weapons",
	S10: "Hate",
	S11: "Suicide & Self-Harm",
	S12: "Sexual Content",
	S13: "Elections",
	S14: "Code Interpreter Abuse",
	P1: "Prompt Injection",
};

/** Logs per page (the API's maximum) and pages read per gateway: a window's refusals, not its whole history. */
const LOG_PAGE = 50;
const LOG_PAGES = 4;
/** How many of the latest refusals are listed one by one. */
const RECENT_REFUSALS = 50;
/**
 * The flag scan's bounds. Guardrails flags have no log filter, so finding them means reading
 * successful logs: 250 a gateway, on at most 8 gateways, keeps one call well inside a Worker's
 * subrequest allowance. What falls outside is reported, never silently left out.
 */
const FLAG_PAGES = 5;
const FLAG_GATEWAYS = 8;

/** The page's slice, as the logs can apply it. */
export interface AiGatewayLogSlice {
	gateway?: string;
	provider?: string;
	model?: string;
	user?: string;
}

/** The Logs API's `filters` for a slice; the gateway is a path, not a filter. */
function sliceFilters(slice: AiGatewayLogSlice): { key: string; operator: string; value: string[] }[] {
	return [
		...(slice.provider ? [{ key: "provider", operator: "eq", value: [slice.provider] }] : []),
		...(slice.model ? [{ key: "model", operator: "eq", value: [slice.model] }] : []),
		...(slice.user
			? [
					{ key: "metadata.key", operator: "eq", value: ["user"] },
					{ key: "metadata.value", operator: "eq", value: [slice.user] },
				]
			: []),
	];
}

export interface GuardrailSide {
	block: string[];
	flag: string[];
}

export interface AiGatewaySettings {
	id: string;
	isDefault: boolean;
	/** Seconds; 0 is off. */
	cacheTtl: number;
	/** null when no limit is set. */
	rateLimit: { limit: number; intervalSeconds: number; technique: string } | null;
	authentication: boolean;
	collectLogs: boolean;
	logLimit: number | null;
	/** null when Guardrails are off on the gateway. */
	guardrails: { prompt: GuardrailSide; response: GuardrailSide } | null;
	/** null when DLP is off. Policy ids are the names given in the dashboard. */
	dlp: { policies: { name: string; action: string; check: string[]; profiles: number; enabled: boolean }[] } | null;
	spendLimits: boolean;
}

export interface AiGatewayRouteStep {
	id: string;
	type: string;
	/** For a model step. */
	model?: string;
	provider?: string;
	/** For a conditional step: its test, written out ("metadata.tier = \"pro\""). */
	condition?: string;
	/** For a rate or budget step. */
	limit?: { kind: string; key: string; limit: number; windowSeconds: number };
	/** Where each outcome leads: next, true/false, success/fallback. */
	next: Record<string, string>;
}

export interface AiGatewayRoute {
	gateway: string;
	name: string;
	/** The id requests use, as the logs and analytics record it. */
	model: string;
	steps: AiGatewayRouteStep[];
	/** Every model the route can send to, in step order. */
	models: string[];
}

export interface AiGatewayConfigResult {
	gateways: AiGatewaySettings[];
	routes: AiGatewayRoute[];
	/** The category names, so the page shows the docs' words without a copy of its own. */
	categoryNames: Record<string, string>;
	/** Set when the read failed, most often for want of AI Gateway: Read on the token. */
	error: string | null;
}

export type RefusalReason = "guardrails" | "guardrails-unlogged" | "guardrail-check" | "dlp" | "rate-limited" | "payment" | "cancelled" | "error" | "other";

export interface AiGatewayRefusal {
	at: string;
	gateway: string;
	model: string;
	provider: string;
	status: number;
	reason: RefusalReason;
	/** The Guardrails categories that blocked it, with the side they were found on. */
	categories: { side: "prompt" | "response"; code: string }[];
	dlpAction: string | null;
	/** The API's own word for a rejection: rate_limited, payment_defaulted, … */
	rejection: string | null;
}

export interface AiGatewayRefusalGroup {
	reason: RefusalReason;
	/** A category code, a rejection word or a status code: what tells this group apart. */
	detail: string;
	side: "prompt" | "response" | null;
	count: number;
	gateways: string[];
}

export interface AiGatewayRefusalsResult {
	groups: AiGatewayRefusalGroup[];
	recent: AiGatewayRefusal[];
	/** Failed requests the logs hold for the window, and how many of them were read. */
	total: number;
	read: number;
	/** Gateways whose logs could not be read, with why. */
	failed: { gateway: string; error: string }[];
	categoryNames: Record<string, string>;
	error: string | null;
}

interface RawGateway {
	id: string;
	is_default?: boolean;
	cache_ttl?: number;
	rate_limiting_limit?: number;
	rate_limiting_interval?: number;
	rate_limiting_technique?: string;
	authentication?: boolean;
	collect_logs?: boolean;
	log_management?: number | null;
	guardrails?: { prompt?: Record<string, string>; response?: Record<string, string> } | null;
	dlp?: { enabled?: boolean; policies?: { id?: string; enabled?: boolean; action?: string; check?: string[]; profiles?: string[] }[] } | null;
	spend_limits?: { enabled?: boolean } | null;
}

interface RawStep {
	id: string;
	type: string;
	properties?: Record<string, unknown> | null;
	outputs?: Record<string, { elementId?: string }> | null;
}

export type FlagSide = "prompt" | "response";

export interface AiGatewayFlagGroup {
	kind: "guardrails" | "dlp";
	/** A category code, or a DLP policy's name. */
	detail: string;
	side: FlagSide | null;
	count: number;
	/** How many of those are logged calls to the guard model itself, not an application's request. */
	onGuardModel: number;
	gateways: string[];
}

export interface AiGatewayFlagsResult {
	groups: AiGatewayFlagGroup[];
	/** Requests carrying at least one flag, of those read. */
	flagged: number;
	/** Successful logs read, and how many the window holds on the gateways scanned. */
	scanned: number;
	total: number;
	/** Gateways with Guardrails or DLP left out by the scan's bound. */
	skipped: string[];
	failed: { gateway: string; error: string }[];
	categoryNames: Record<string, string>;
	error: string | null;
}

/** What a log entry is reduced to before anything else looks at it. */
interface RawLog {
	created_at?: string;
	model?: string;
	provider?: string;
	status_code?: number;
	success?: boolean;
	guardrails?: { prompt?: Record<string, string>; response?: Record<string, string> } | null;
	dlp_action?: string | null;
	dlp_profiles?: { policy_ids?: string[]; check?: string }[] | null;
	rejection_reason?: string | null;
}

interface Envelope<T> {
	success?: boolean;
	result?: T;
	data?: T;
	errors?: { code?: number; message?: string }[];
	result_info?: { total_count?: number; total_pages?: number };
}

async function getJson<T>(path: string, token: string): Promise<{ ok: true; body: Envelope<T> } | { ok: false; error: string }> {
	const response = await upstreamFetch(`${CF_API_BASE}${path}`, { headers: authHeaders(token) });
	let body: Envelope<T>;
	try {
		body = await response.json();
	} catch {
		return { ok: false, error: `Cloudflare returned a non-JSON response (HTTP ${response.status})` };
	}
	if (!response.ok || body.success === false) {
		const first = body.errors?.[0];
		// 10000 is Cloudflare's "Authentication error": the token is fine but lacks this permission.
		if (first?.code === 10000 || response.status === 403) return { ok: false, error: "The API token lacks AI Gateway: Read" };
		return { ok: false, error: first?.message || `HTTP ${response.status}` };
	}
	return { ok: true, body };
}

async function listGateways(accountId: string, token: string): Promise<{ gateways: RawGateway[] } | { error: string }> {
	const all: RawGateway[] = [];
	for (let page = 1; page <= 20; page++) {
		const read = await getJson<RawGateway[]>(`/accounts/${accountId}/ai-gateway/gateways?per_page=50&page=${page}`, token);
		if (!read.ok) return { error: read.error };
		const rows = read.body.result ?? [];
		all.push(...rows);
		if (rows.length < 50) break;
	}
	return { gateways: all };
}

const sideOf = (raw: Record<string, string> | undefined): GuardrailSide => {
	const entries = Object.entries(raw ?? {});
	const order = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
	return {
		block: entries.filter(([, v]) => v === "BLOCK").map(([k]) => k).sort(order),
		flag: entries.filter(([, v]) => v === "FLAG").map(([k]) => k).sort(order),
	};
};

export function trimGateway(g: RawGateway): AiGatewaySettings {
	const policies = g.dlp?.enabled ? (g.dlp.policies ?? []) : [];
	return {
		id: g.id,
		isDefault: Boolean(g.is_default),
		cacheTtl: g.cache_ttl ?? 0,
		rateLimit: g.rate_limiting_limit && g.rate_limiting_interval ? { limit: g.rate_limiting_limit, intervalSeconds: g.rate_limiting_interval, technique: g.rate_limiting_technique ?? "" } : null,
		authentication: Boolean(g.authentication),
		collectLogs: Boolean(g.collect_logs),
		logLimit: g.log_management ?? null,
		guardrails: g.guardrails ? { prompt: sideOf(g.guardrails.prompt), response: sideOf(g.guardrails.response) } : null,
		dlp: g.dlp?.enabled
			? {
					policies: policies.map((p) => ({
						name: p.id ?? "",
						action: p.action ?? "",
						check: p.check ?? [],
						profiles: p.profiles?.length ?? 0,
						enabled: p.enabled !== false,
					})),
				}
			: null,
		spendLimits: Boolean(g.spend_limits?.enabled),
	};
}

/** A route condition written out: `{"$and":[{"$or":[{"metadata.tier":{"$eq":"pro"}}]}]}` → `metadata.tier = "pro"`. */
export function conditionText(node: unknown): string {
	if (!node || typeof node !== "object") return String(node ?? "");
	const entries = Object.entries(node as Record<string, unknown>);
	const parts = entries.map(([key, value]) => {
		if (key === "$and" || key === "$or") {
			const list = Array.isArray(value) ? value.map(conditionText).filter(Boolean) : [];
			const joined = list.join(key === "$and" ? " and " : " or ");
			return list.length > 1 ? `(${joined})` : joined;
		}
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const ops: Record<string, string> = { $eq: "=", $ne: "≠", $gt: ">", $gte: "≥", $lt: "<", $lte: "≤", $in: "in", $nin: "not in", $contains: "contains" };
			return Object.entries(value as Record<string, unknown>)
				.map(([op, v]) => `${key} ${ops[op] ?? op} ${JSON.stringify(v)}`)
				.join(" and ");
		}
		return `${key} = ${JSON.stringify(value)}`;
	});
	const text = parts.join(" and ");
	return text.startsWith("(") && text.endsWith(")") && parts.length === 1 ? text.slice(1, -1) : text;
}

export function routeSteps(raw: RawStep[]): AiGatewayRouteStep[] {
	return raw.map((step) => {
		const p = step.properties ?? {};
		const next = Object.fromEntries(Object.entries(step.outputs ?? {}).map(([k, v]) => [k, v?.elementId ?? ""]).filter(([, v]) => v));
		const out: AiGatewayRouteStep = { id: step.id, type: step.type, next };
		if (step.type === "model") {
			out.model = typeof p.model === "string" ? p.model : undefined;
			out.provider = typeof p.provider === "string" ? p.provider : undefined;
		} else if (step.type === "conditional") {
			out.condition = conditionText(p.conditions ?? p);
		} else if (typeof p.limit === "number") {
			out.limit = { kind: String(p.limitType ?? step.type), key: String(p.key ?? ""), limit: p.limit, windowSeconds: Number(p.window ?? 0) };
		}
		return out;
	});
}

/** Models a route can reach, in the order a walk from its start meets them. */
export function routeModels(steps: AiGatewayRouteStep[]): string[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const start = steps.find((s) => s.type === "start") ?? steps[0];
	const seen = new Set<string>();
	const models: string[] = [];
	const walk = (id: string | undefined) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		const step = byId.get(id);
		if (!step) return;
		if (step.model && !models.includes(step.model)) models.push(step.model);
		for (const key of ["next", "true", "success", "false", "fallback", ...Object.keys(step.next)]) walk(step.next[key]);
	};
	walk(start?.id);
	return models;
}

export async function fetchAiGatewayConfig(accountId: string, token: string): Promise<AiGatewayConfigResult> {
	const listed = await listGateways(accountId, token);
	if ("error" in listed) return { gateways: [], routes: [], categoryNames: GUARDRAIL_CATEGORIES, error: listed.error };
	const routes: AiGatewayRoute[] = [];
	await mapWithConcurrency(listed.gateways, 4, async (g) => {
		const list = await getJson<{ routes?: { id: string; name: string }[] }>(`/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(g.id)}/routes`, token);
		if (!list.ok) return;
		const found = list.body.data?.routes ?? list.body.result?.routes ?? [];
		for (const r of found) {
			const detail = await getJson<{ version?: { data?: RawStep[] } }>(
				`/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(g.id)}/routes/${encodeURIComponent(r.id)}`,
				token,
			);
			const raw = detail.ok ? (detail.body.result?.version?.data ?? detail.body.data?.version?.data ?? []) : [];
			const steps = routeSteps(raw);
			routes.push({ gateway: g.id, name: r.name, model: `dynamic/${r.name}`, steps, models: routeModels(steps) });
		}
	});
	routes.sort((a, b) => a.gateway.localeCompare(b.gateway) || a.name.localeCompare(b.name));
	return { gateways: listed.gateways.map(trimGateway).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id)), routes, categoryNames: GUARDRAIL_CATEGORIES, error: null };
}

/** The guard models AI Gateway calls to evaluate a prompt; their own failures are logged too. */
const GUARD_MODELS = /llama-guard|prompt-guard/;

/** Why a failed request failed, from the named fields of its log entry only. */
export function refusalOf(gateway: string, log: RawLog): AiGatewayRefusal {
	const categories: AiGatewayRefusal["categories"] = [];
	for (const side of ["prompt", "response"] as const) {
		for (const [code, action] of Object.entries(log.guardrails?.[side] ?? {})) if (action === "BLOCK") categories.push({ side, code });
	}
	const status = log.status_code ?? 0;
	const model = log.model ?? "";
	const rejection = log.rejection_reason ?? null;
	const reason: RefusalReason =
		log.dlp_action === "BLOCK"
			? "dlp"
			: categories.length
				? "guardrails"
				: GUARD_MODELS.test(model)
					? "guardrail-check"
					: rejection === "rate_limited" || status === 429
						? "rate-limited"
						: rejection?.startsWith("payment") || status === 402
							? "payment"
							: status === 422 || status === 424
								? "guardrails-unlogged"
								: status === 499
									? "cancelled"
									: rejection
										? "other"
										: "error";
	return { at: log.created_at ?? "", gateway, model, provider: log.provider ?? "", status, reason, categories, dlpAction: log.dlp_action ?? null, rejection };
}

export function groupRefusals(rows: AiGatewayRefusal[]): AiGatewayRefusalGroup[] {
	const groups = new Map<string, AiGatewayRefusalGroup>();
	const add = (reason: RefusalReason, detail: string, side: "prompt" | "response" | null, gateway: string) => {
		const id = JSON.stringify([reason, detail, side]);
		const g = groups.get(id) ?? { reason, detail, side, count: 0, gateways: [] };
		g.count += 1;
		if (!g.gateways.includes(gateway)) g.gateways.push(gateway);
		groups.set(id, g);
	};
	for (const r of rows) {
		if (r.reason === "guardrails") for (const c of r.categories) add(r.reason, c.code, c.side, r.gateway);
		else add(r.reason, r.reason === "error" ? String(r.status) : (r.rejection ?? (r.reason === "dlp" ? (r.dlpAction ?? "") : String(r.status))), null, r.gateway);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** What one allowed request was flagged for, from its named fields only. */
export function flagsOf(log: RawLog): { kind: "guardrails" | "dlp"; detail: string; side: FlagSide | null }[] {
	const out: { kind: "guardrails" | "dlp"; detail: string; side: FlagSide | null }[] = [];
	for (const side of ["prompt", "response"] as const) {
		for (const [code, action] of Object.entries(log.guardrails?.[side] ?? {})) if (action === "FLAG") out.push({ kind: "guardrails", detail: code, side });
	}
	if (log.dlp_action === "FLAG") {
		const seen = new Set<string>();
		for (const hit of log.dlp_profiles ?? []) {
			const side: FlagSide | null = hit.check === "REQUEST" ? "prompt" : hit.check === "RESPONSE" ? "response" : null;
			for (const policy of hit.policy_ids ?? []) {
				const id = JSON.stringify([policy, side]);
				if (seen.has(id)) continue;
				seen.add(id);
				out.push({ kind: "dlp", detail: policy, side });
			}
		}
		if (!seen.size) out.push({ kind: "dlp", detail: "(policy not named)", side: null });
	}
	return out;
}

export async function fetchAiGatewayFlags(accountId: string, token: string, since: string, until: string, slice: AiGatewayLogSlice = {}): Promise<AiGatewayFlagsResult> {
	const listed = await listGateways(accountId, token);
	const empty = { groups: [], flagged: 0, scanned: 0, total: 0, skipped: [], failed: [], categoryNames: GUARDRAIL_CATEGORIES };
	if ("error" in listed) return { ...empty, error: listed.error };
	const watching = listed.gateways.filter((g) => g.collect_logs !== false && (g.guardrails || g.dlp?.enabled) && (!slice.gateway || g.id === slice.gateway));
	const scanning = watching.slice(0, FLAG_GATEWAYS);
	const groups = new Map<string, AiGatewayFlagGroup>();
	const failed: AiGatewayFlagsResult["failed"] = [];
	let flagged = 0;
	let scanned = 0;
	let total = 0;
	const filters = sliceFilters(slice);
	await mapWithConcurrency(scanning, 4, async (g) => {
		for (let page = 1; page <= FLAG_PAGES; page++) {
			const query = new URLSearchParams({ per_page: String(LOG_PAGE), page: String(page), success: "true", start_date: since, end_date: until, order_by: "created_at", order_by_direction: "desc" });
			if (filters.length) query.set("filters", JSON.stringify(filters));
			const read = await getJson<RawLog[]>(`/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(g.id)}/logs?${query}`, token);
			if (!read.ok) {
				failed.push({ gateway: g.id, error: read.error });
				return;
			}
			if (page === 1) total += read.body.result_info?.total_count ?? 0;
			const logs = read.body.result ?? [];
			scanned += logs.length;
			for (const log of logs) {
				const flags = flagsOf(log);
				if (flags.length) flagged += 1;
				for (const flag of flags) {
					const id = JSON.stringify([flag.kind, flag.detail, flag.side]);
					const group = groups.get(id) ?? { ...flag, count: 0, onGuardModel: 0, gateways: [] };
					group.count += 1;
					if (GUARD_MODELS.test(log.model ?? "")) group.onGuardModel += 1;
					if (!group.gateways.includes(g.id)) group.gateways.push(g.id);
					groups.set(id, group);
				}
			}
			if (logs.length < LOG_PAGE) return;
		}
	});
	return {
		...empty,
		groups: [...groups.values()].sort((a, b) => b.count - a.count),
		flagged,
		scanned,
		total,
		skipped: watching.slice(FLAG_GATEWAYS).map((g) => g.id),
		failed: failed.sort((a, b) => a.gateway.localeCompare(b.gateway)),
		error: null,
	};
}

export async function fetchAiGatewayRefusals(accountId: string, token: string, since: string, until: string, slice: AiGatewayLogSlice = {}): Promise<AiGatewayRefusalsResult> {
	const listed = await listGateways(accountId, token);
	if ("error" in listed) return { groups: [], recent: [], total: 0, read: 0, failed: [], categoryNames: GUARDRAIL_CATEGORIES, error: listed.error };
	const rows: AiGatewayRefusal[] = [];
	const failed: AiGatewayRefusalsResult["failed"] = [];
	let total = 0;
	await mapWithConcurrency(
		listed.gateways.filter((g) => g.collect_logs !== false && (!slice.gateway || g.id === slice.gateway)),
		4,
		async (g) => {
			for (let page = 1; page <= LOG_PAGES; page++) {
				const query = new URLSearchParams({
					per_page: String(LOG_PAGE),
					page: String(page),
					success: "false",
					start_date: since,
					end_date: until,
					order_by: "created_at",
					order_by_direction: "desc",
				});
				if (sliceFilters(slice).length) query.set("filters", JSON.stringify(sliceFilters(slice)));
				const read = await getJson<RawLog[]>(`/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(g.id)}/logs?${query}`, token);
				if (!read.ok) {
					failed.push({ gateway: g.id, error: read.error });
					return;
				}
				if (page === 1) total += read.body.result_info?.total_count ?? 0;
				// Reduced to named fields at once: prompts, answers and metadata go no further.
				const logs = read.body.result ?? [];
				for (const log of logs) rows.push(refusalOf(g.id, log));
				if (logs.length < LOG_PAGE) return;
			}
		},
	);
	rows.sort((a, b) => b.at.localeCompare(a.at));
	return { groups: groupRefusals(rows), recent: rows.slice(0, RECENT_REFUSALS), total, read: rows.length, failed: failed.sort((a, b) => a.gateway.localeCompare(b.gateway)), categoryNames: GUARDRAIL_CATEGORIES, error: null };
}

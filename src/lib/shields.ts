/**
 * Shields: Page Shield (client-side script/connection inventory) and API Shield (endpoint
 * inventory, schema validation, session identifiers) posture, per zone.
 *
 * Page Shield is verified live against this account: `page_shield`, `page_shield/scripts`,
 * `page_shield/connections` and `page_shield/policies` all return real data with the bound
 * read-only token. API Shield is NOT verified: every `/api_gateway/*` read returned
 * "Authentication error" on every zone tried — the bound token lacks the scope. That half is
 * built from Cloudflare's documented shapes (see the doc comments on each fetcher) and must
 * render that fact honestly: "not checked — missing permission", never "0 endpoints". A read
 * that returns zero real zero is indistinguishable from a read that never happened, so the two
 * must never collapse into the same rendering.
 *
 * Same rule as zone-health.ts throughout: a check that could not run is unknown with its reason,
 * never folded into "no issues" or "0".
 */

import { mapWithConcurrency, restList } from "./cf-rest";

/** Workers allow ~6 simultaneous connections per host; same budget as every other section. */
const CONCURRENCY = 5;

/** Cap on scripts/connections returned per zone, so one zone with a huge inventory cannot blow
 * up the payload or the edge cache entry. */
const ITEMS_CAP = 500;

/** A script/connection first seen within this many days of "now" is called out as new. */
const NEW_THIRD_PARTY_DAYS = 7;

export class ShieldsError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "ShieldsError";
	}
}

export interface ShZone {
	id: string;
	name: string;
}

// ---------------------------------------------------------------------------
// Shared "why this read could not happen" reasoning

/**
 * Code 10000 ("Authentication error") and a bare 401/403 are the same fact from the operator's
 * chair: the bound token is not authorized for this read. 404 is a different fact — the feature
 * itself is not available on this plan or zone, not a permission problem — so it gets its own
 * reason rather than being folded into "missing permission".
 */
function unavailableReason(status: number, code: number | undefined, message: string, scopeName: string): string {
	if (status === 401 || status === 403 || code === 10000) {
		return `Needs "${scopeName}" — the bound token is not authorized to read this on this zone.`;
	}
	if (status === 404) {
		return "Not available on this plan or zone.";
	}
	return message || `HTTP ${status}`;
}

function normaliseHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/** True when `host` is the zone's own domain or a subdomain of it — i.e. not third-party. */
export function isOwnHost(host: string, zoneName: string): boolean {
	const h = normaliseHost(host);
	const z = normaliseHost(zoneName);
	return h === z || h.endsWith(`.${z}`);
}

function daysSince(iso: string | null, now: Date): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.floor((now.getTime() - t) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Page Shield

export interface PageShieldStatus {
	available: boolean;
	reason?: string;
	enabled: boolean;
	updatedAt: string | null;
	useCloudflareReportingEndpoint: boolean;
	useConnectionUrlPath: boolean;
}

export interface PsItem {
	id: string;
	url: string;
	host: string;
	addedAt: string | null;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
	firstPageUrl: string | null;
	pageUrls: string[];
	status: string;
	domainReportedMalicious: boolean;
	maliciousDomainCategories: string[] | null;
	urlReportedMalicious: boolean | null;
	maliciousUrlCategories: string[] | null;
	urlContainsCdnCgiPath: boolean;
	versionsCount: number;
	/** Host is not this zone's own domain or a subdomain of it. */
	thirdParty: boolean;
	/** Third-party and first seen within the last 7 days. */
	newThirdParty: boolean;
}

export interface PsList {
	available: boolean;
	reason?: string;
	items: PsItem[];
	/** True when the account had more than {@link ITEMS_CAP} items and the list was truncated. */
	truncated: boolean;
	totalSeen: number;
}

export interface PsPolicy {
	id: string;
	description: string;
	action: string | null;
	enabled: boolean | null;
	expression: string | null;
}

export interface PsPolicies {
	available: boolean;
	reason?: string;
	items: PsPolicy[];
}

export interface ZonePageShield {
	status: PageShieldStatus;
	scripts: PsList;
	connections: PsList;
	policies: PsPolicies;
}

interface CfPageShieldSettings {
	enabled?: boolean;
	updated_at?: string;
	use_cloudflare_reporting_endpoint?: boolean;
	use_connection_url_path?: boolean;
}

interface CfPageShieldItem {
	id?: string;
	url?: string;
	host?: string;
	added_at?: string;
	first_seen_at?: string;
	last_seen_at?: string;
	first_page_url?: string;
	page_urls?: string[];
	status?: string;
	domain_reported_malicious?: boolean;
	malicious_domain_categories?: string[] | null;
	url_reported_malicious?: boolean | null;
	malicious_url_categories?: string[] | null;
	url_contains_cdn_cgi_path?: boolean;
	versions?: unknown[];
}

interface CfPageShieldPolicy {
	id?: string;
	description?: string;
	action?: string;
	enabled?: boolean;
	expression?: string;
}

/** `page_shield` returns a single settings object as `result`, unlike every list endpoint in
 * this file — so it is fetched directly rather than through {@link restList}, which expects an
 * array and would misread an object `result` as an empty page. */
async function fetchPageShieldStatus(zoneId: string, token: string): Promise<PageShieldStatus> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/page_shield`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	let body: { success?: boolean; result?: CfPageShieldSettings; errors?: { message?: string; code?: number }[] };
	try {
		body = await response.json();
	} catch {
		return { available: false, reason: "Cloudflare returned a non-JSON response", enabled: false, updatedAt: null, useCloudflareReportingEndpoint: false, useConnectionUrlPath: false };
	}
	if (!response.ok || !body.success) {
		return {
			available: false,
			reason: unavailableReason(response.status, body.errors?.[0]?.code, body.errors?.[0]?.message || "", "Client-side Security: Read"),
			enabled: false,
			updatedAt: null,
			useCloudflareReportingEndpoint: false,
			useConnectionUrlPath: false,
		};
	}
	const r = body.result || {};
	return {
		available: true,
		enabled: Boolean(r.enabled),
		updatedAt: r.updated_at ?? null,
		useCloudflareReportingEndpoint: Boolean(r.use_cloudflare_reporting_endpoint),
		useConnectionUrlPath: Boolean(r.use_connection_url_path),
	};
}

function mapPsItem(raw: CfPageShieldItem, zoneName: string, now: Date): PsItem {
	const host = raw.host || "";
	const thirdParty = host !== "" && !isOwnHost(host, zoneName);
	const age = daysSince(raw.first_seen_at ?? null, now);
	const newThirdParty = thirdParty && age !== null && age >= 0 && age <= NEW_THIRD_PARTY_DAYS;
	return {
		id: raw.id || "",
		url: raw.url || "",
		host,
		addedAt: raw.added_at ?? null,
		firstSeenAt: raw.first_seen_at ?? null,
		lastSeenAt: raw.last_seen_at ?? null,
		firstPageUrl: raw.first_page_url ?? null,
		pageUrls: raw.page_urls ?? [],
		status: raw.status || "unknown",
		domainReportedMalicious: Boolean(raw.domain_reported_malicious),
		maliciousDomainCategories: raw.malicious_domain_categories ?? null,
		urlReportedMalicious: raw.url_reported_malicious ?? null,
		maliciousUrlCategories: raw.malicious_url_categories ?? null,
		urlContainsCdnCgiPath: Boolean(raw.url_contains_cdn_cgi_path),
		versionsCount: raw.versions?.length ?? 0,
		thirdParty,
		newThirdParty,
	};
}

async function fetchPsList(path: string, zoneId: string, zoneName: string, token: string, now: Date, scopeName: string): Promise<PsList> {
	const res = await restList<CfPageShieldItem>(path.replace("{zoneId}", zoneId), token);
	if (res.error) {
		return { available: false, reason: unavailableReason(res.status, res.code, res.error, scopeName), items: [], truncated: false, totalSeen: 0 };
	}
	const totalSeen = res.result.length;
	const capped = res.result.slice(0, ITEMS_CAP);
	return { available: true, items: capped.map((r) => mapPsItem(r, zoneName, now)), truncated: totalSeen > ITEMS_CAP, totalSeen };
}

async function fetchPsPolicies(zoneId: string, token: string): Promise<PsPolicies> {
	const res = await restList<CfPageShieldPolicy>(`/zones/${zoneId}/page_shield/policies`, token);
	if (res.error) {
		return { available: false, reason: unavailableReason(res.status, res.code, res.error, "Client-side Security: Read"), items: [] };
	}
	return {
		available: true,
		items: res.result.map((p) => ({
			id: p.id || "",
			description: p.description || "",
			action: p.action ?? null,
			enabled: p.enabled ?? null,
			expression: p.expression ?? null,
		})),
	};
}

async function fetchZonePageShield(zone: ShZone, token: string, now: Date): Promise<ZonePageShield> {
	const [status, scripts, connections, policies] = await Promise.all([
		fetchPageShieldStatus(zone.id, token),
		fetchPsList(`/zones/{zoneId}/page_shield/scripts`, zone.id, zone.name, token, now, "Client-side Security: Read"),
		fetchPsList(`/zones/{zoneId}/page_shield/connections`, zone.id, zone.name, token, now, "Client-side Security: Read"),
		fetchPsPolicies(zone.id, token),
	]);
	return { status, scripts, connections, policies };
}

// ---------------------------------------------------------------------------
// API Shield
//
// UNVERIFIED against a live account (every /api_gateway/* read returned "Authentication error"
// with the bound token). Shapes below are built from Cloudflare's documented API resources:
//   https://developers.cloudflare.com/api/resources/api_gateway/
//   https://developers.cloudflare.com/api/resources/api_gateway/subresources/user_schemas/
//   https://developers.cloudflare.com/api/resources/api_gateway/subresources/settings/subresources/schema_validation/
//   https://developers.cloudflare.com/api-shield/management-and-monitoring/
//   https://developers.cloudflare.com/api-shield/security/schema-validation/

export interface ApiShieldOperations {
	available: boolean;
	reason?: string;
	savedCount: number;
}

export type DiscoveryState = "review" | "saved" | "ignored";

export interface ApiShieldDiscovery {
	available: boolean;
	reason?: string;
	/** state === "review": discovered but not yet saved as a known operation. */
	discoveredNotSavedCount: number;
}

export type SchemaValidationAction = "none" | "log" | "block" | null;

export interface ApiShieldSchemaValidation {
	available: boolean;
	reason?: string;
	defaultAction: SchemaValidationAction;
	/** Cloudflare's own per-operation override count is not exposed by this endpoint; derived
	 * from reading each operation's schema_info when the operations list is also readable. Null
	 * when it could not be derived. */
	perOperationOverrideCount: number | null;
}

export interface ApiShieldUserSchemas {
	available: boolean;
	reason?: string;
	count: number;
}

export interface ApiShieldConfiguration {
	available: boolean;
	reason?: string;
	sessionIdentifierConfigured: boolean;
	sessionIdentifierCount: number;
}

export interface ZoneApiShield {
	operations: ApiShieldOperations;
	discovery: ApiShieldDiscovery;
	schemaValidation: ApiShieldSchemaValidation;
	userSchemas: ApiShieldUserSchemas;
	configuration: ApiShieldConfiguration;
	/** True only when every one of the five reads above succeeded. Drives the "checked vs not
	 * checked" KPI — a zone with even one unreadable half is not fully checked. */
	fullyChecked: boolean;
}

interface CfApiGatewayOperation {
	operation_id?: string;
}

interface CfApiGatewayDiscoveryOperation {
	id?: string;
	state?: DiscoveryState;
}

interface CfApiGatewaySchemaValidationSettings {
	validation_default_mitigation_action?: string;
}

interface CfApiGatewayUserSchema {
	schema_id?: string;
}

interface CfApiGatewayConfiguration {
	auth_id_characteristics?: { name?: string; type?: string }[];
}

async function fetchApiShieldOperations(zoneId: string, token: string): Promise<ApiShieldOperations> {
	const res = await restList<CfApiGatewayOperation>(`/zones/${zoneId}/api_gateway/operations`, token);
	if (res.error) {
		return { available: false, reason: unavailableReason(res.status, res.code, res.error, "API Gateway: Read"), savedCount: 0 };
	}
	return { available: true, savedCount: res.result.length };
}

async function fetchApiShieldDiscovery(zoneId: string, token: string): Promise<ApiShieldDiscovery> {
	const res = await restList<CfApiGatewayDiscoveryOperation>(`/zones/${zoneId}/api_gateway/discovery/operations`, token);
	if (res.error) {
		return { available: false, reason: unavailableReason(res.status, res.code, res.error, "API Gateway: Read"), discoveredNotSavedCount: 0 };
	}
	return { available: true, discoveredNotSavedCount: res.result.filter((o) => o.state === "review").length };
}

async function fetchApiShieldSchemaValidation(zoneId: string, token: string): Promise<ApiShieldSchemaValidation> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/api_gateway/settings/schema_validation`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	let body: { success?: boolean; result?: CfApiGatewaySchemaValidationSettings; errors?: { message?: string; code?: number }[] };
	try {
		body = await response.json();
	} catch {
		return { available: false, reason: "Cloudflare returned a non-JSON response", defaultAction: null, perOperationOverrideCount: null };
	}
	if (!response.ok || !body.success) {
		return {
			available: false,
			reason: unavailableReason(response.status, body.errors?.[0]?.code, body.errors?.[0]?.message || "", "API Gateway: Read"),
			defaultAction: null,
			perOperationOverrideCount: null,
		};
	}
	const action = body.result?.validation_default_mitigation_action;
	return {
		available: true,
		defaultAction: action === "none" || action === "log" || action === "block" ? action : null,
		// Per-operation overrides live on each operation's own schema_info, not on this endpoint;
		// not derived here to avoid an extra fan-out per zone for a count nothing else needs yet.
		perOperationOverrideCount: null,
	};
}

async function fetchApiShieldUserSchemas(zoneId: string, token: string): Promise<ApiShieldUserSchemas> {
	const res = await restList<CfApiGatewayUserSchema>(`/zones/${zoneId}/api_gateway/user_schemas`, token);
	if (res.error) {
		return { available: false, reason: unavailableReason(res.status, res.code, res.error, "API Gateway: Read"), count: 0 };
	}
	return { available: true, count: res.result.length };
}

async function fetchApiShieldConfiguration(zoneId: string, token: string): Promise<ApiShieldConfiguration> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/api_gateway/configuration`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	let body: { success?: boolean; result?: CfApiGatewayConfiguration; errors?: { message?: string; code?: number }[] };
	try {
		body = await response.json();
	} catch {
		return { available: false, reason: "Cloudflare returned a non-JSON response", sessionIdentifierConfigured: false, sessionIdentifierCount: 0 };
	}
	if (!response.ok || !body.success) {
		return {
			available: false,
			reason: unavailableReason(response.status, body.errors?.[0]?.code, body.errors?.[0]?.message || "", "API Gateway: Read"),
			sessionIdentifierConfigured: false,
			sessionIdentifierCount: 0,
		};
	}
	const chars = body.result?.auth_id_characteristics ?? [];
	return { available: true, sessionIdentifierConfigured: chars.length > 0, sessionIdentifierCount: chars.length };
}

async function fetchZoneApiShield(zone: ShZone, token: string): Promise<ZoneApiShield> {
	const [operations, discovery, schemaValidation, userSchemas, configuration] = await Promise.all([
		fetchApiShieldOperations(zone.id, token),
		fetchApiShieldDiscovery(zone.id, token),
		fetchApiShieldSchemaValidation(zone.id, token),
		fetchApiShieldUserSchemas(zone.id, token),
		fetchApiShieldConfiguration(zone.id, token),
	]);
	const fullyChecked = operations.available && discovery.available && schemaValidation.available && userSchemas.available && configuration.available;
	return { operations, discovery, schemaValidation, userSchemas, configuration, fullyChecked };
}

// ---------------------------------------------------------------------------
// Findings

export type ShieldSeverity = "high" | "medium" | "low" | "info";

export interface ShieldFinding {
	severity: ShieldSeverity;
	zoneId: string;
	zoneName: string;
	source: "page-shield" | "api-shield";
	title: string;
	detail: string;
}

export interface ZoneShields {
	zoneId: string;
	zoneName: string;
	pageShield: ZonePageShield;
	apiShield: ZoneApiShield;
}

export interface ShieldsResult {
	zones: ZoneShields[];
	findings: ShieldFinding[];
	totals: {
		zones: number;
		pageShieldEnabledZones: number;
		scripts: number;
		connections: number;
		maliciousFlags: number;
		apiShieldCheckedZones: number;
		apiShieldNotCheckedZones: number;
		findings: { high: number; medium: number; low: number; info: number };
	};
	errors: { source: string; message: string }[];
}

function buildPageShieldFindings(zone: ZoneShields): ShieldFinding[] {
	const out: ShieldFinding[] = [];
	const { pageShield } = zone;

	if (pageShield.status.available && !pageShield.status.enabled) {
		out.push({
			severity: "low",
			zoneId: zone.zoneId,
			zoneName: zone.zoneName,
			source: "page-shield",
			title: "Page Shield disabled",
			detail: "This zone is not monitoring client-side scripts or connections.",
		});
	}

	for (const list of [pageShield.scripts, pageShield.connections]) {
		if (!list.available) continue;
		for (const item of list.items) {
			if (item.domainReportedMalicious || item.urlReportedMalicious) {
				const categories = [...(item.maliciousDomainCategories ?? []), ...(item.maliciousUrlCategories ?? [])];
				out.push({
					severity: "high",
					zoneId: zone.zoneId,
					zoneName: zone.zoneName,
					source: "page-shield",
					title: "Malicious script or connection flagged",
					detail: `${item.host || item.url}${categories.length ? ` — ${categories.join(", ")}` : ""}`,
				});
			}
			if (item.newThirdParty) {
				out.push({
					severity: "info",
					zoneId: zone.zoneId,
					zoneName: zone.zoneName,
					source: "page-shield",
					title: "New third-party script",
					detail: `${item.host} first seen ${item.firstSeenAt ?? "recently"} — not this zone's own domain.`,
				});
			}
		}
	}

	const scriptsPresent = pageShield.scripts.available && pageShield.scripts.totalSeen > 0;
	if (pageShield.policies.available && pageShield.policies.items.length === 0 && scriptsPresent) {
		out.push({
			severity: "low",
			zoneId: zone.zoneId,
			zoneName: zone.zoneName,
			source: "page-shield",
			title: "No Page Shield policies",
			detail: "Scripts are present but no content security policy is enforced — monitoring only.",
		});
	}

	return out;
}

function buildApiShieldFindings(zone: ZoneShields): ShieldFinding[] {
	const out: ShieldFinding[] = [];
	const { apiShield } = zone;

	if (apiShield.discovery.available && apiShield.discovery.discoveredNotSavedCount > 0) {
		out.push({
			severity: "low",
			zoneId: zone.zoneId,
			zoneName: zone.zoneName,
			source: "api-shield",
			title: "Discovered endpoints not saved",
			detail: `${apiShield.discovery.discoveredNotSavedCount} endpoint(s) discovered but not yet added to the known-operations inventory.`,
		});
	}

	if (apiShield.schemaValidation.available && apiShield.userSchemas.available && apiShield.userSchemas.count > 0) {
		const action = apiShield.schemaValidation.defaultAction;
		if (action === null || action === "none" || action === "log") {
			out.push({
				severity: "medium",
				zoneId: zone.zoneId,
				zoneName: zone.zoneName,
				source: "api-shield",
				title: "Schema validation not blocking",
				detail: `${apiShield.userSchemas.count} schema(s) uploaded, but the default validation action is "${action ?? "none"}" — non-conforming requests are not blocked.`,
			});
		}
	}

	if (apiShield.configuration.available && !apiShield.configuration.sessionIdentifierConfigured) {
		out.push({
			severity: "info",
			zoneId: zone.zoneId,
			zoneName: zone.zoneName,
			source: "api-shield",
			title: "No session identifier configured",
			detail: "API Gateway has no session identifier (header/cookie/JWT claim) configured for this zone.",
		});
	}

	return out;
}

export function buildShieldsReport(zones: ZoneShields[], errors: { source: string; message: string }[]): ShieldsResult {
	const findings: ShieldFinding[] = [];
	for (const zone of zones) {
		findings.push(...buildPageShieldFindings(zone), ...buildApiShieldFindings(zone));
	}

	let high = 0;
	let medium = 0;
	let low = 0;
	let info = 0;
	for (const f of findings) {
		if (f.severity === "high") high++;
		else if (f.severity === "medium") medium++;
		else if (f.severity === "low") low++;
		else info++;
	}

	const pageShieldEnabledZones = zones.filter((z) => z.pageShield.status.available && z.pageShield.status.enabled).length;
	const scripts = zones.reduce((sum, z) => sum + (z.pageShield.scripts.available ? z.pageShield.scripts.totalSeen : 0), 0);
	const connections = zones.reduce((sum, z) => sum + (z.pageShield.connections.available ? z.pageShield.connections.totalSeen : 0), 0);
	const maliciousFlags = findings.filter((f) => f.source === "page-shield" && f.severity === "high").length;
	const apiShieldCheckedZones = zones.filter((z) => z.apiShield.fullyChecked).length;
	const apiShieldNotCheckedZones = zones.length - apiShieldCheckedZones;

	return {
		zones,
		findings,
		totals: {
			zones: zones.length,
			pageShieldEnabledZones,
			scripts,
			connections,
			maliciousFlags,
			apiShieldCheckedZones,
			apiShieldNotCheckedZones,
			findings: { high, medium, low, info },
		},
		errors,
	};
}

/**
 * One account's (or one zone's, when narrowed) Shields report, fetched fresh from Cloudflare.
 * Page Shield and API Shield are independent per zone and fetched in parallel; a failure in one
 * never blocks the other.
 */
export async function fetchShieldsReport(zones: ShZone[], token: string, now: Date = new Date()): Promise<ShieldsResult> {
	const errors: { source: string; message: string }[] = [];

	const zoneShields = await mapWithConcurrency(zones, CONCURRENCY, async (zone): Promise<ZoneShields> => {
		const [pageShield, apiShield] = await Promise.all([fetchZonePageShield(zone, token, now), fetchZoneApiShield(zone, token)]);
		return { zoneId: zone.id, zoneName: zone.name, pageShield, apiShield };
	});

	return buildShieldsReport(zoneShields, errors);
}

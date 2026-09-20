/**
 * OpenAPI 3.1 document for the Flarelens Worker's API.
 *
 * A plain, structurally-typed object — no schema-builder dependency. Built fresh per request in
 * src/routes/docs.ts so `info.version` can read the running deployment's version metadata.
 *
 * Every path below was written by reading its route in src/routes/*.ts, not guessed. Deep,
 * account-specific report shapes (PQC, Shields, DNS, Zone Health, Bots, tunnel map, AI Security,
 * Cache analysis) are described at the top level only; their nested detail is typed as a generic
 * object and the description says so, rather than implying full coverage that was never checked
 * field-by-field against a live account.
 */

// Minimal structural alias: this file builds a document, not a schema-validated one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = any;

const HEX_ID_SCHEMA: Schema = {
	type: "string",
	pattern: "^[a-f0-9]{32}$",
	description: "32-character lowercase hex Cloudflare identifier (account, zone, or app id).",
	example: "023e105f4ecef8ad9ca31a8372d0c353",
};

const errorEnvelope: Schema = {
	type: "object",
	required: ["success", "errors"],
	properties: {
		success: { const: false },
		errors: {
			type: "array",
			items: {
				type: "object",
				required: ["message"],
				properties: { message: { type: "string" } },
			},
		},
	},
};

function successEnvelope(resultSchema: Schema, extra: Record<string, Schema> = {}): Schema {
	return {
		type: "object",
		required: ["success", "result"],
		properties: {
			success: { const: true },
			result: resultSchema,
			...extra,
		},
	};
}

const genericObject: Schema = { type: "object", description: "Structure not fully pinned here — see the route's own module for the exact shape.", additionalProperties: true };

const cacheHeaders = {
	"X-Flarelens-Cache": {
		description: "HIT when served from the 60s edge cache, MISS when computed fresh.",
		schema: { type: "string", enum: ["HIT", "MISS"] },
	},
	"X-Flarelens-Cached-At": {
		description: "ISO-8601 instant the cached value was computed. Present only on a HIT.",
		schema: { type: "string", format: "date-time" },
	},
};

const freshHeaderParam: Schema = {
	name: "X-Flarelens-Fresh",
	in: "header",
	required: false,
	description: "Set to \"1\" to bypass the 60-second edge cache and force a live upstream read.",
	schema: { type: "string", enum: ["1"] },
};

const accountIdQuery: Schema = {
	name: "account_id",
	in: "query",
	required: true,
	description: "Cloudflare account id to scope the request to.",
	schema: HEX_ID_SCHEMA,
};

const zoneIdQuery: Schema = {
	name: "zone_id",
	in: "query",
	required: false,
	description: "Narrow the account-wide report to a single zone.",
	schema: HEX_ID_SCHEMA,
};

const response400: Schema = {
	description: "The request failed input validation (missing or malformed id, body, or parameter).",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
};
const response401: Schema = {
	description: "No valid credential was presented — no Cloudflare Access session and no bearer token, or server mode is not configured on this deployment.",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
};
const response403: Schema = {
	description: "The requested account or zone is outside this deployment's allowlist (server mode only), or the route refuses server mode entirely.",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
};
const response404: Schema = {
	description: "The requested resource does not exist (e.g. no metrics target configured for this tunnel).",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
};
const response502: Schema = {
	description: "The Cloudflare API (REST or GraphQL) failed or returned something this Worker could not parse.",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
};

function jsonBody(schema: Schema, required = true): Schema {
	return { required, content: { "application/json": { schema } } };
}

function okJson(schema: Schema, headers?: Schema): Schema {
	const res: Schema = { description: "Success.", content: { "application/json": { schema } } };
	if (headers) res.headers = headers;
	return res;
}

export interface OpenApiOptions {
	/** Version string, preferring the running deployment's CF_VERSION_METADATA when present. */
	version: string;
}

export function buildOpenApiDocument({ version }: OpenApiOptions): Record<string, unknown> {
	return {
		openapi: "3.1.0",
		info: {
			title: "Flarelens API",
			version,
			description: [
				"Cloudflare ops dashboard, read-only against the Cloudflare API.",
				"",
				"**Auth.** Two credential modes, resolved per request (see `securitySchemes` below): " +
					"`cloudflareToken` — an `Authorization: Bearer <token>` the caller supplies; Cloudflare enforces that " +
					"token's own scope, and it always wins when present. `accessSession` — no bearer header, so the request " +
					"must instead carry a Cloudflare Access session (the `Cf-Access-Jwt-Assertion` header, or the " +
					"`CF_Authorization` cookie a browser carries after an Access login); the Worker then acts under its own " +
					"bound `CF_API_TOKEN`, restricted to the deployment's account/zone allowlist. This 'server mode' is only " +
					"available on deployments that bind a token, and some routes (AI Security, unless `AI_REQUIRES_BYOT=0`) " +
					"refuse it outright because their data is too sensitive to read under a shared credential.",
				"",
				"**Caching.** Several report-shaped GET routes are cached at the edge for 60 seconds, keyed by the " +
					"resolved token's fingerprint, auth mode and query parameters. A HIT is marked with " +
					"`X-Flarelens-Cache: HIT` and `X-Flarelens-Cached-At`; send `X-Flarelens-Fresh: 1` to force a live read.",
				"",
				"**No caching of responses by the browser.** Every `/api/*` response carries `Cache-Control: no-store` — " +
					"payloads are token-derived and must never be cached by an intermediary.",
				"",
				"**Quota.** Nearly every route calls the real Cloudflare API (REST and/or GraphQL Analytics) on your " +
					"behalf. Calling these endpoints, including from this page's \"Try it out\", spends real Cloudflare API " +
					"quota against the connected account.",
			].join("\n"),
		},
		servers: [{ url: "/" }],
		security: [{ accessSession: [] }, { cloudflareToken: [] }],
		tags: [
			{ name: "Core", description: "Bootstrap: health, accounts, deployment config, zones." },
			{ name: "Access", description: "Zero Trust Access applications, policies, identity providers." },
			{ name: "Access Usage", description: "Access login telemetry." },
			{ name: "AI Gateway", description: "AI Gateway request volume, tokens, spend." },
			{ name: "AI Security", description: "AI Security for Apps detections." },
			{ name: "Rate Limits & Bots", description: "Rate-limit rules and bot management posture." },
			{ name: "Cache", description: "Cache rules analysis." },
			{ name: "DNS", description: "Account-wide DNS record inventory." },
			{ name: "Gateway", description: "Zero Trust Gateway (DNS resolver + HTTP) usage and policies." },
			{ name: "PQC", description: "Post-quantum TLS readiness." },
			{ name: "Request Trace", description: "Per-request forensics by Ray ID." },
			{ name: "Shields", description: "Page Shield + API Shield posture." },
			{ name: "Tunnels", description: "Access-application-to-Tunnel mapping and connector metrics." },
			{ name: "WAF", description: "WAF firewall events and ruleset metadata." },
			{ name: "Workers AI", description: "Workers AI inference usage." },
			{ name: "Workers", description: "Workers script analytics." },
			{ name: "Zone Health", description: "Certificate expiry and DNS hygiene." },
			{ name: "Docs", description: "This documentation itself." },
		],
		paths: {
			"/health": {
				get: {
					tags: ["Core"],
					summary: "Liveness check",
					description: "Unauthenticated. Used by uptime checks; carries no account data.",
					security: [],
					responses: {
						200: okJson({ type: "object", properties: { status: { const: "ok" } } }),
					},
				},
			},
			"/api/accounts": {
				get: {
					tags: ["Core"],
					summary: "List accounts the caller may use",
					description: "In server mode the response is narrowed to the deployment's account allowlist, so an account the allowlist would refuse is never offered.",
					responses: {
						200: okJson(successEnvelope({ type: "array", items: { type: "object", properties: { id: HEX_ID_SCHEMA, name: { type: "string" } } } })),
						401: response401,
					},
				},
			},
			"/api/config": {
				get: {
					tags: ["Core"],
					summary: "SPA bootstrap: credential mode and available accounts",
					description:
						"Both security schemes apply, but neither is enforced here the way other routes enforce them: a request with no credential at all, or one whose Access session does not verify, still gets 200 with `mode: \"byot\"` rather than a 401 — deliberately, so an unauthenticated caller learns nothing about whether this deployment binds a server token. The bound token itself is never included in the response.",
					responses: {
						200: okJson(
							successEnvelope({
								type: "object",
								properties: {
									mode: { type: "string", enum: ["byot", "server"] },
									accounts: { type: "array", items: { type: "object", properties: { id: HEX_ID_SCHEMA, name: { type: "string" } } } },
									accountsError: { type: "string" },
									version: {
										type: "object",
										properties: { id: { type: "string" }, tag: { type: "string" }, timestamp: { type: "string" } },
									},
								},
							}),
						),
					},
				},
			},
			"/api/zones": {
				get: {
					tags: ["Core"],
					summary: "Zones in an account",
					description: "id and name only. Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope({ type: "array", items: { type: "object", properties: { id: HEX_ID_SCHEMA, name: { type: "string" } } } }), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/data": {
				get: {
					tags: ["Access"],
					summary: "Access applications, policies, identity providers, groups, and referenced lists",
					description:
						"The Access review page's primary payload: every application with its resolved policies (embedded or fetched), identity providers, groups, reusable policies, and the Zero Trust lists any of those policies reference (capped at 500 items per list). Enrichment fields (groups, reusable policies, lists) degrade to empty-with-`*_error: true` rather than failing the whole request when the token lacks that read scope.",
					parameters: [accountIdQuery],
					responses: {
						200: okJson(
							successEnvelope({
								type: "object",
								properties: {
									apps: { type: "array", items: genericObject },
									idps: { type: "array", items: genericObject },
									groups: { type: "array", items: genericObject },
									groups_error: { type: "boolean" },
									reusable_policies: { type: "array", items: genericObject },
									reusable_policies_error: { type: "boolean" },
									lists: { type: "array", items: genericObject },
									lists_error: { type: "boolean" },
								},
							}),
						),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/access/usage": {
				post: {
					tags: ["Access Usage"],
					summary: "Access login telemetry",
					description: "Aggregate-only: volume, success/failure split, and top apps/identity providers/countries for a window of at most 7 days. Never a per-identity access log.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "from", "to"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							from: { type: "string", format: "date-time", description: "ISO-8601 UTC instant." },
							to: { type: "string", format: "date-time", description: "ISO-8601 UTC instant. Must be after `from`, and at most 7 days later." },
							granularity: { type: "string", default: "hourly" },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/ai-gateway/usage": {
				post: {
					tags: ["AI Gateway"],
					summary: "AI Gateway request volume, tokens, spend, errors, cache",
					description:
						"Window of at most 30 days. Field names in the underlying analytics query have never been run against a real account — see src/lib/ai-gateway.ts's own caveat — so treat the exact response shape as provisional.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "from", "to"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							from: { type: "string", format: "date-time" },
							to: { type: "string", format: "date-time" },
							granularity: { type: "string", default: "hourly" },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/ai-security/analyze": {
				post: {
					tags: ["AI Security"],
					summary: "AI Security for Apps: KPIs, detections, flagged requests",
					description:
						"Refuses server mode by default (401, `\"This section requires your own Cloudflare API token\"`) because these rows carry client IPs and request payloads; set `AI_REQUIRES_BYOT=0` on the deployment to allow the bound token here too. A 401/403 from the upstream analytics call is passed through unchanged rather than folded into a 502, since the client treats those as an expired session.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							zoneId: HEX_ID_SCHEMA,
						},
						additionalProperties: true,
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/bots/report": {
				get: {
					tags: ["Rate Limits & Bots"],
					summary: "Rate-limit rules and bot management settings, per zone",
					description: "Account entrypoint plus every zone's entrypoint for rate limits, and bot management settings per zone. `zone_id` narrows to one zone. Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, zoneIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/cache/analyze": {
				post: {
					tags: ["Cache"],
					summary: "Cache rules analysis for a zone",
					description: "Rule inventory, versioning info, and computed insights/health for a zone's cache rules over a chosen lookback (`rangeHours`, restricted to the allowed set; defaults to 24).",
					requestBody: jsonBody({
						type: "object",
						required: ["zoneId"],
						properties: {
							zoneId: HEX_ID_SCHEMA,
							rangeHours: { type: "number", description: "Must be one of the allowed lookback windows; falls back to 24 otherwise." },
						},
					}),
					responses: {
						200: okJson(
							successEnvelope({
								type: "object",
								properties: {
									zoneName: { type: "string" },
									zoneId: HEX_ID_SCHEMA,
									rangeHours: { type: "number" },
									insights: genericObject,
									health: genericObject,
									versioning: genericObject,
								},
								additionalProperties: true,
							}),
						),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/dns/records": {
				get: {
					tags: ["DNS"],
					summary: "Every DNS record across the account's zones, flattened",
					description: "One table across all zones (or one zone with `zone_id`). A zone whose DNS read fails still appears, carrying its own error, rather than being silently dropped. Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, zoneIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/gateway/policies": {
				get: {
					tags: ["Gateway"],
					summary: "Zero Trust Gateway rules, grouped and enforcement-ordered",
					description: "Account-wide. Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/gateway/usage": {
				post: {
					tags: ["Gateway"],
					summary: "Zero Trust Gateway usage (DNS resolver + Gateway HTTP)",
					description: "Window of at most 30 days.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "from", "to"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							from: { type: "string", format: "date-time" },
							to: { type: "string", format: "date-time" },
							granularity: { type: "string", default: "hourly" },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/pqc/report": {
				get: {
					tags: ["PQC"],
					summary: "Post-quantum TLS readiness per hostname",
					description:
						"Zone-wide inventory (narrow with `zone_id`) of which proxiable hostnames are covered by post-quantum key exchange, plus a measured adoption figure for the last 24 hours where the account's analytics schema supports it. Needs Zone: DNS: Read for the record inventory; without it a zone reports its own error rather than an empty, clean-looking account. Edge-cached for 60 seconds — this route measured ~4.3s upstream.",
					parameters: [accountIdQuery, zoneIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/request/trace": {
				post: {
					tags: ["Request Trace"],
					summary: "Per-request forensics by Ray ID",
					description: "Looks a single request up by its 16-hex-character Ray ID within a lookback window (`minutes`, clamped to 30–43200; default 1440 = 24h).",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "rayId"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							rayId: { type: "string", pattern: "^[0-9a-f]{16}$" },
							zoneId: HEX_ID_SCHEMA,
							minutes: { type: "number", minimum: 30, maximum: 43200, default: 1440 },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/shields/report": {
				get: {
					tags: ["Shields"],
					summary: "Page Shield + API Shield posture, per zone",
					description: "Account-wide client & API protection posture (narrow with `zone_id`). Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, zoneIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/access/tunnels": {
				get: {
					tags: ["Tunnels"],
					summary: "Access application → Tunnel → origin mapping",
					description:
						"Joins Access applications to the Tunnel ingress rules serving their hostnames, plus each tunnel's connectors, health notes (including whether a connector's cloudflared version is behind the latest release), and whether it has a configured metrics target. Edge-cached for 60 seconds — measured ~4.0s upstream.",
					parameters: [accountIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/tunnels/{tunnelId}/metrics": {
				get: {
					tags: ["Tunnels"],
					summary: "Connector CPU/memory/HA metrics for one tunnel",
					description:
						"Reads a Prometheus metrics document from an operator-published `cloudflared` endpoint — the target comes only from the deploy-time `TUNNEL_METRICS` secret, never from the client. Not edge-cached: an on-demand \"Load metrics\" action. The tunnel is verified to belong to the authenticated account before any metrics fetch.",
					parameters: [
						{ name: "tunnelId", in: "path", required: true, schema: { type: "string" }, description: "Cloudflare Tunnel id." },
						accountIdQuery,
					],
					responses: {
						200: okJson(successEnvelope({ type: "object", properties: { metrics: { type: "string" }, fetchedAt: { type: "string", format: "date-time" } } })),
						400: response400,
						401: response401,
						403: response403,
						404: response404,
						502: response502,
					},
				},
			},
			"/api/waf/events": {
				post: {
					tags: ["WAF"],
					summary: "WAF firewall events for an account or zone",
					description:
						"Cursor-paginates the GraphQL `firewallEventsAdaptive` dataset backwards from now over a lookback (`minutes`, clamped to 5–43200; default 360), deduped by ray+rule+action, up to 5 pages of 10,000 rows. `diagnostics.truncated` reports whether the page cap was hit before the window was exhausted.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							zoneId: HEX_ID_SCHEMA,
							minutes: { type: "number", minimum: 5, maximum: 43200, default: 360 },
						},
					}),
					responses: {
						200: okJson({
							type: "object",
							properties: {
								success: { const: true },
								result: { type: "array", items: genericObject },
								diagnostics: {
									type: "object",
									properties: {
										scope: { type: "string", enum: ["account", "zone"] },
										since: { type: "string" },
										minutes: { type: "number" },
										pages: { type: "number" },
										eventCount: { type: "number" },
										truncated: { type: "boolean" },
									},
								},
							},
						}),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/waf/rulesets": {
				get: {
					tags: ["WAF"],
					summary: "WAF ruleset metadata (rule names, descriptions) for an account or zone",
					description: "Account-level by default; add `zone_id` for one zone, or `include_zones=1` to fan out across every zone in the account.",
					parameters: [
						accountIdQuery,
						zoneIdQuery,
						{ name: "include_zones", in: "query", required: false, description: "Set to \"1\" to also collect ruleset metadata for every zone in the account.", schema: { type: "string", enum: ["1"] } },
					],
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/workers-ai/usage": {
				post: {
					tags: ["Workers AI"],
					summary: "Workers AI inference volume, neurons, tokens, models",
					description: "Window of at most 30 days.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "from", "to"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							from: { type: "string", format: "date-time" },
							to: { type: "string", format: "date-time" },
							granularity: { type: "string", default: "hourly" },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/workers/scripts": {
				get: {
					tags: ["Workers"],
					summary: "Worker script names on the account",
					description: "Powers the Workers section's per-script filter.",
					parameters: [accountIdQuery],
					responses: {
						200: okJson(successEnvelope({ type: "array", items: { type: "string" } })),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/workers/metrics": {
				post: {
					tags: ["Workers"],
					summary: "Per-script Worker invocation metrics for a window",
					description: "Window of at most 30 days; both bounds must be full ISO-8601 UTC instants.",
					requestBody: jsonBody({
						type: "object",
						required: ["accountId", "from", "to"],
						properties: {
							accountId: HEX_ID_SCHEMA,
							from: { type: "string", format: "date-time" },
							to: { type: "string", format: "date-time" },
							granularity: { type: "string", default: "hourly" },
						},
					}),
					responses: {
						200: okJson(successEnvelope(genericObject)),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/zone-health/report": {
				get: {
					tags: ["Zone Health"],
					summary: "Certificate expiry and DNS hygiene for every zone",
					description: "Account-wide (narrow with `zone_id`). Edge-cached for 60 seconds.",
					parameters: [accountIdQuery, zoneIdQuery, freshHeaderParam],
					responses: {
						200: okJson(successEnvelope(genericObject), cacheHeaders),
						400: response400,
						401: response401,
						403: response403,
						502: response502,
					},
				},
			},
			"/api/openapi.json": {
				get: {
					tags: ["Docs"],
					summary: "This OpenAPI document",
					security: [{ accessSession: [] }, { cloudflareToken: [] }],
					responses: {
						200: okJson({ type: "object", description: "The OpenAPI 3.1 document itself." }),
						401: response401,
					},
				},
			},
			"/docs": {
				get: {
					tags: ["Docs"],
					summary: "Interactive API documentation (Swagger UI)",
					description: "Self-hosted Swagger UI over `/api/openapi.json`. \"Try it out\" sends real requests against the connected Cloudflare account.",
					security: [{ accessSession: [] }, { cloudflareToken: [] }],
					responses: {
						200: { description: "Swagger UI HTML page.", content: { "text/html": { schema: { type: "string" } } } },
						401: { description: "Unauthenticated — short HTML page explaining how to reach this page.", content: { "text/html": { schema: { type: "string" } } } },
					},
				},
			},
		},
		components: {
			schemas: {
				ErrorEnvelope: errorEnvelope,
			},
			securitySchemes: {
				accessSession: {
					type: "apiKey",
					in: "header",
					name: "Cf-Access-Jwt-Assertion",
					description:
						"Cloudflare Access session, handled by Access in front of the Worker. A browser presents this as the Cf-Access-Jwt-Assertion header or the CF_Authorization cookie after logging in through Access; only available on deployments that bind a server-mode Cloudflare API token, and refused outright by routes that opt out of server mode (e.g. AI Security, unless AI_REQUIRES_BYOT=0).",
				},
				cloudflareToken: {
					type: "http",
					scheme: "bearer",
					description: "The caller's own Cloudflare API token, sent as `Authorization: Bearer <token>`. Present, this always wins over an Access session — Cloudflare enforces the token's own scope.",
				},
			},
		},
	};
}

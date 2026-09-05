/**
 * What the ported AI Security data layer needs from its environment.
 *
 * Trimmed from the standalone app's Env, which also carried an ASSETS binding, version
 * metadata and page-level feature flags — that app hosted itself and rendered its own HTML.
 * Here Flarelens owns hosting and rendering, so this is only the Cloudflare credentials and
 * the two knobs the GraphQL layer actually reads.
 */
export interface AiSecEnv {
	CF_API_TOKEN: string;
	/**
	 * Short fingerprint of CF_API_TOKEN, mixed into every cache key this module writes.
	 *
	 * The dashboard this came from ran on a single server-side token, so caching GraphQL
	 * results under a key built from the query parameters alone was safe: every request was the
	 * same tenant. Flarelens takes the token from each request's Authorization header, so those
	 * same keys would let one operator's telemetry be served to the next one who asked for the
	 * same zone and window. The fingerprint restores the tenant boundary the original design got
	 * for free by having exactly one tenant.
	 *
	 * A hash, never the token: cache keys reach logs and the Cache API's own storage.
	 */
	CF_TOKEN_FP: string;
	CF_ACCOUNT_ID: string;
	/** Comma-separated zone ids; empty means every zone the token can see. */
	ZONE_ALLOWLIST?: string;
	/**
	 * Overrides the AI Security Log Mode ruleset id the payload query filters on, so a ruleset
	 * id change on Cloudflare's side is a config edit rather than a code change. Empty string
	 * drops the filter entirely.
	 */
	AI_LOG_MODE_RULESET_ID?: string;
}

export interface Zone {
	id: string;
	name: string;
}

export interface GraphQLError {
	message: string;
	path?: (string | number)[];
	extensions?: Record<string, unknown>;
}

export class CfApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'CfApiError';
	}
}

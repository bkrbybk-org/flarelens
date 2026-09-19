import type { Hono } from "hono";
import type { AuthEnv } from "./lib/auth";

export interface Env extends AuthEnv {
	ASSETS: Fetcher;
	/** Populated by the version_metadata binding; absent under `wrangler dev` without it. */
	CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
	/**
	 * "0" lets AI Security run under the bound token like every other section. Default is the
	 * restrictive one: that section's rows carry client IPs and encrypted request payloads, and
	 * reading them under a shared credential collapses the Cloudflare audit trail to one identity.
	 */
	AI_REQUIRES_BYOT?: string;
	/**
	 * JSON array of `{ tunnelId, connectorId?, url }` — the only source of metrics targets.
	 * Deploy-time only (`wrangler secret put`): a request can never name its own URL. See
	 * src/lib/tunnel-metrics.ts.
	 */
	TUNNEL_METRICS?: string;
	/** Access service token sent as `CF-Access-Client-Id` when fetching a configured metrics URL. */
	METRICS_ACCESS_CLIENT_ID?: string;
	/** Access service token secret, sent as `CF-Access-Client-Secret`. */
	METRICS_ACCESS_CLIENT_SECRET?: string;
}

export type App = Hono<{ Bindings: Env }>;

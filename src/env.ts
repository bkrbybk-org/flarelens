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
}

export type App = Hono<{ Bindings: Env }>;

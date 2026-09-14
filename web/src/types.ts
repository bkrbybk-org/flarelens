export interface CfAccount {
	id: string;
	name?: string;
}

export interface CfZone {
	id: string;
	name?: string;
}

export interface CfIdp {
	id: string;
	name?: string;
	type?: string;
}

export interface CfGroup {
	id: string;
	name?: string;
	include?: unknown[];
	exclude?: unknown[];
	require?: unknown[];
	created_at?: string;
	updated_at?: string;
}

export interface CfPolicy {
	id: string;
	name?: string;
	decision?: string;
	reusable?: boolean;
	include?: unknown[];
	exclude?: unknown[];
	require?: unknown[];
	[key: string]: unknown;
}

/** Origins allowed to make cross-origin requests to the app, per Access's CORS setting. */
export interface CfCorsHeaders {
	allow_all_origins?: boolean;
	allowed_origins?: string[];
	allow_credentials?: boolean;
	[key: string]: unknown;
}

export interface CfApp {
	id: string;
	name?: string;
	domain?: string;
	type?: string;
	tags?: string[];
	allowed_idps?: string[];
	self_hosted_domains?: string[];
	destinations?: unknown[];
	created_at?: string;
	updated_at?: string;
	policies: CfPolicy[];
	policies_error: boolean;
	/** Go-style duration string, e.g. "24h", "730h", "30m". Parse with parseSessionDuration. */
	session_duration?: string;
	/** Explicit false means the session cookie is readable by page scripts (not HttpOnly). */
	http_only_cookie_attribute?: boolean;
	cors_headers?: CfCorsHeaders;
	[key: string]: unknown;
}

/**
 * A Zero Trust list a policy rule references. Items are capped server-side; `count` is the
 * list's own size, so a truncated render still states the truth about how big it is.
 */
export interface CfList {
	id: string;
	name: string;
	type: string;
	count: number;
	items: string[];
	items_truncated: boolean;
	error?: string;
}

export interface ZeroTrustData {
	apps: CfApp[];
	idps: CfIdp[];
	groups: CfGroup[];
	groups_error: boolean;
	reusable_policies: CfPolicy[];
	reusable_policies_error: boolean;
	lists: CfList[];
	lists_error: boolean;
}

export interface ApiEnvelope<T> {
	success: boolean;
	errors?: { message: string }[];
	result?: T;
}

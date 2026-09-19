/**
 * Cloudflare API shapes shared across more than one route module.
 *
 * Mirrors web/src/types.ts rather than importing it: the Worker and the SPA each declare their
 * own shape for every Cloudflare type in this codebase, so a reader looking at either side alone
 * sees the real shape without having to cross-reference the other package.
 */

export interface CfIdp {
	id: string;
	name?: string;
	type?: string;
}

export interface CfPolicy {
	id: string;
	name?: string;
	decision?: string;
	reusable?: boolean;
	include?: unknown[];
	exclude?: unknown[];
	require?: unknown[];
}

export interface CfApp {
	id: string;
	name?: string;
	domain?: string;
	self_hosted_domains?: string[];
	[key: string]: unknown;
}

export interface CfZone {
	id: string;
	name?: string;
}

export interface CfAccount {
	id: string;
	name?: string;
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

export interface CfListMeta {
	id: string;
	name?: string;
	/** EMAIL, IP, DOMAIN, SERIAL … */
	type?: string;
	count?: number;
}

export interface CfList {
	id: string;
	name: string;
	type: string;
	count: number;
	items: string[];
	items_truncated: boolean;
	/** Set when the list's items could not be read, so an empty list is not mistaken for a read one. */
	error?: string;
}

export interface CfAccount {
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
	[key: string]: unknown;
}

export interface ZeroTrustData {
	apps: CfApp[];
	idps: CfIdp[];
	groups: CfGroup[];
	reusable_policies: CfPolicy[];
}

export interface ApiEnvelope<T> {
	success: boolean;
	errors?: { message: string }[];
	result?: T;
}

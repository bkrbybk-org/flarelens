/** Mirrors the shapes in src/lib/shields.ts. Redeclared per side, as the other sections do. */

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
	thirdParty: boolean;
	newThirdParty: boolean;
}

export interface PsList {
	available: boolean;
	reason?: string;
	items: PsItem[];
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

export type SchemaValidationAction = "none" | "log" | "block" | null;

export interface ApiShieldOperations {
	available: boolean;
	reason?: string;
	savedCount: number;
}

export interface ApiShieldDiscovery {
	available: boolean;
	reason?: string;
	discoveredNotSavedCount: number;
}

export interface ApiShieldSchemaValidation {
	available: boolean;
	reason?: string;
	defaultAction: SchemaValidationAction;
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
	fullyChecked: boolean;
}

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

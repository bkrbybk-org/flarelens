/** Mirrors the shapes in src/lib/ratelimit-bot.ts. Redeclared per side, as the other sections do. */

export interface RateLimitParams {
	characteristics?: string[];
	period?: number;
	requestsPerPeriod?: number;
	mitigationTimeout?: number;
	countingExpression?: string;
	requestsToOrigin?: boolean;
	scorePerPeriod?: number;
	scoreResponseHeaderName?: string;
}

export interface RateLimitRule {
	ruleId: string;
	description: string;
	enabled: boolean;
	action: string;
	expression: string;
	ratelimit: RateLimitParams | null;
}

export interface RateLimitScope {
	scope: "zone" | "account";
	zoneId?: string;
	zoneName?: string;
	status: "ok" | "unknown";
	reason?: string;
	rules: RateLimitRule[];
}

export type BotPlanTier = "enterprise" | "super_bot_fight_mode" | "bot_fight_mode" | "unknown";

export interface BotManagementZone {
	zoneId: string;
	zoneName: string;
	status: "ok" | "unknown";
	reason?: string;
	planTier: BotPlanTier;
	settings: Record<string, unknown>;
}

export type FindingSeverity = "high" | "medium" | "low" | "info";

export interface Finding {
	severity: FindingSeverity;
	zoneId?: string;
	zoneName?: string;
	title: string;
	detail: string;
}

export interface RatelimitBotResult {
	rateLimit: RateLimitScope[];
	botManagement: BotManagementZone[];
	findings: Finding[];
	totals: {
		zonesChecked: number;
		rateLimitRules: number;
		zonesWithNoRateLimitRules: number;
		botProtectionOn: number;
		botProtectionOff: number;
		botProtectionUnknown: number;
	};
}

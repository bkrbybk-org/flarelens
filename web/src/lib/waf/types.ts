export interface FirewallEvent {
	action?: string;
	clientCountryName?: string;
	clientIP?: string;
	clientRequestHTTPHost?: string;
	clientRequestPath?: string;
	datetime?: string;
	ruleId?: string;
	source?: string;
}

export interface RuleMetaEntry {
	name: string;
	ruleId?: string;
	source: string;
	type: string;
	level: string;
	phase?: string;
	ruleset?: string;
	rulesetName?: string;
	rulesetId?: string;
	kind?: string;
	action?: string;
	enabled?: boolean;
	expression?: string;
	isRuleset?: boolean;
}

export type RuleMetaMap = Record<string, RuleMetaEntry>;

export interface ChildRuleRow {
	id: string;
	name: string;
	configuredAction: string;
	total: number;
	actions: Record<string, number>;
	hosts: Map<string, number>;
	lastSeen: string;
}

export interface RulesetRow {
	ruleId: string;
	ruleName: string;
	source: string;
	type: string;
	level: string;
	childRules: Map<string, ChildRuleRow>;
	total: number;
	actions: Record<string, number>;
	hosts: Map<string, number>;
	times: number[];
	lastSeen: string;
}

export interface RuleReviewRow {
	id: string;
	name: string;
	ruleset: string;
	rulesetId: string;
	/** "account", "zone" or "zone:<name>", from the scope the ruleset was read under. */
	source: string;
	type: string;
	level: string;
	configuredAction: string;
	enabled: boolean;
	known: boolean;
	expression: string;
	total: number;
	actions: Record<string, number>;
	hosts: Map<string, number>;
	paths: Map<string, number>;
	times: number[];
	lastSeen: string;
}

export interface WafDiagnostics {
	scope: string;
	since: string;
	minutes: number;
	pages: number;
	eventCount: number;
	truncated: boolean;
}

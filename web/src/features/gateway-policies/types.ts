/** Mirrors the shapes in src/lib/gateway-policies.ts. Redeclared per side, as the other sections do. */

export type GwFilterType = "dns" | "http" | "l4" | "dns_resolver";

export interface GwRule {
	id: string;
	name: string;
	description: string;
	precedence: number;
	enabled: boolean;
	action: string;
	filterType: GwFilterType | null;
	filters: GwFilterType[];
	traffic: string;
	identity: string;
	devicePosture: string;
	untrustedCertAction: string | null;
	updatedAt: string | null;
}

export interface GwStage {
	id: GwFilterType;
	label: string;
	detail: string;
}

export interface GwOrderedRule {
	rule: GwRule;
	position: number;
	terminating: boolean;
	shadowedBy?: { id: string; name: string };
}

export interface GwStageView {
	stage: GwStage;
	rules: GwOrderedRule[];
}

export type GwSeverity = "high" | "medium" | "low" | "info";

export interface GwFinding {
	severity: GwSeverity;
	ruleId: string | null;
	ruleName: string | null;
	filterType: GwFilterType | null;
	title: string;
	detail: string;
}

export interface GwReport {
	rules: GwRule[];
	stages: GwStageView[];
	findings: GwFinding[];
	totals: {
		rules: number;
		enabled: number;
		disabled: number;
		byType: Record<GwFilterType, number>;
	};
}

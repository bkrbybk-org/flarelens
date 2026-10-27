import { decisiveLeaves, unknownReasons, type Explanation } from "./explain-expr";
import type { OwaspBreakdown, RayReview } from "./ray-review";
import type { RayVerdict } from "./ray-verdict";

/**
 * One investigated request as a Markdown case report — for a ticket, a hand-off, or the reply to
 * whoever reported the false positive. Everything comes from what the page already showed; no new
 * reads. It carries the client's IP and the request path, which is the point of a case report, so
 * the page says so next to the button.
 */

export interface RayReportInput {
	rayId: string;
	zone?: string;
	request: Record<string, unknown>;
	headline: string;
	verdict: RayVerdict;
	review: RayReview;
	decidedExplanation?: Explanation;
	owasp?: OwaspBreakdown | null;
	bot?: string[];
	context?: {
		impact?: { requests: number; distinctClients: number; distinctCapped: boolean; ruleEvents?: number; byAction: Record<string, number> };
		rule?: { total: number; sameClient: number; samePath: number; topHosts: Top[]; topPaths: Top[]; topCountries: Top[]; topNetworks: Top[] };
		timelineRows?: number;
	} | null;
	windowLabel: string;
	generatedAt?: Date;
}

interface Top {
	value: string;
	count: number;
}

/** Markdown-safe inline text: no stray emphasis, links or table breaks from request data. */
export function md(value: unknown): string {
	return String(value ?? "")
		.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`)
		.replace(/\r?\n/g, " ");
}

/** Code spans can't escape a backtick, so a longer fence is used when the text has one. */
function code(value: string): string {
	const fence = value.includes("`") ? "``" : "`";
	return `${fence}${value.includes("`") ? ` ${value} ` : value}${fence}`;
}

const n = (v: number) => v.toLocaleString("en-US");
const top = (rows: Top[]) => rows.map((r) => `${md(r.value)} (${n(r.count)})`).join(", ");

export function buildRayReport(input: RayReportInput): string {
	const r = input.request;
	const lines: string[] = [];
	lines.push(`# Request investigation — Ray ${code(input.rayId)}`, "");
	lines.push(`**${md(input.headline)}**`, "");
	const facts: [string, unknown][] = [
		["Time", r.datetime],
		["Zone", input.zone],
		["Request", [r.clientRequestHTTPMethodName, `${r.clientRequestHTTPHost ?? ""}${r.clientRequestPath ?? ""}`].filter(Boolean).join(" ")],
		["Client", [r.clientIP, r.clientCountryName, r.clientAsn ? `AS${r.clientAsn}` : "", r.clientASNDescription].filter(Boolean).join(" · ")],
		["User agent", r.userAgent ?? r.clientRequestUserAgent],
		["Edge status", r.edgeResponseStatus],
		["Security action", r.securityAction ? `${r.securityAction}${r.securitySource ? ` (${r.securitySource})` : ""}` : ""],
		["WAF attack score", r.wafAttackScore],
		["Bot score", r.botScore],
	];
	for (const [label, value] of facts) {
		if (value !== undefined && value !== null && value !== "") lines.push(`- **${label}:** ${md(value)}`);
	}
	lines.push("");

	const decided = input.verdict.decidedBy;
	if (decided) {
		lines.push("## Deciding rule", "");
		lines.push(`${md(decided.item.row.name)} — ${md(decided.stage.phaseLabel)}, ${md(decided.stage.scope)}${decided.item.row.ruleset ? `, ruleset ${md(decided.item.row.ruleset)}` : ""}, rule #${decided.item.position}.`, "");
		if (decided.item.row.expression) lines.push("```", decided.item.row.expression, "```", "");
		const ex = input.decidedExplanation;
		if (ex?.root) {
			const why = decisiveLeaves(ex.root, true);
			if (why.length) {
				lines.push("Why it matched:", "");
				for (const leaf of why) lines.push(`- ${code(leaf.text)}${leaf.actual ? ` — request: ${md(leaf.actual)}` : ""}`);
				lines.push("");
			}
			const unknown = unknownReasons(ex.root);
			if (unknown.length) lines.push(`Not checkable from the record: ${md(unknown.join("; "))}.`, "");
		}
	}

	lines.push(`## ${md(input.review.title)}`, "");
	for (const p of input.review.points) lines.push(`- ${md(p.text)}`);
	lines.push("");

	if (input.review.suggestions.length) {
		lines.push("## Suggested changes", "", "_Drafts from this one request. Test before enabling._", "");
		for (const s of input.review.suggestions) {
			lines.push(`### ${md(s.title)}`, "", `- **Where:** ${md(s.where)}`, `- **Action:** ${md(s.action)}`);
			if (s.caution) lines.push(`- **Reach:** ${md(s.caution)}`);
			if (s.expression) lines.push("", "```", s.expression, "```");
			lines.push("");
		}
	}

	const ctx = input.context;
	if (ctx?.impact || ctx?.rule) {
		lines.push(`## Surrounding traffic (${md(input.windowLabel)})`, "");
		if (ctx.impact) {
			const clients = `${n(ctx.impact.distinctClients)}${ctx.impact.distinctCapped ? "+" : ""}`;
			lines.push(
				`- **Requests like this one:** ${n(ctx.impact.requests)} from ${clients} clients${ctx.impact.ruleEvents !== undefined ? `; ${n(ctx.impact.ruleEvents)} stopped by the deciding rule` : ""}.`,
			);
			const actions = Object.entries(ctx.impact.byAction).map(([a, c]) => `${md(a === "unknown" ? "served" : a)} ${n(c)}`);
			if (actions.length) lines.push(`- **Their outcomes:** ${actions.join(", ")}.`);
		}
		if (ctx.rule) {
			lines.push(`- **Deciding rule overall:** ${n(ctx.rule.total)} events; ${n(ctx.rule.sameClient)} from this client; ${n(ctx.rule.samePath)} on this path.`);
			if (ctx.rule.topHosts.length) lines.push(`- **Top hosts:** ${top(ctx.rule.topHosts)}`);
			if (ctx.rule.topPaths.length) lines.push(`- **Top paths:** ${top(ctx.rule.topPaths)}`);
			if (ctx.rule.topCountries.length) lines.push(`- **Top countries:** ${top(ctx.rule.topCountries)}`);
			if (ctx.rule.topNetworks.length) lines.push(`- **Top networks:** ${top(ctx.rule.topNetworks)}`);
		}
		if (ctx.timelineRows !== undefined) lines.push(`- **This client, ±1 hour:** ${n(ctx.timelineRows)} sampled requests.`);
		lines.push("");
	}

	if (input.owasp) {
		lines.push(`## OWASP anomaly score: ${input.owasp.total}`, "");
		if (input.owasp.threshold !== undefined) lines.push(`Threshold on this deployment: ${input.owasp.threshold}.`, "");
		for (const c of input.owasp.contributors) lines.push(`- ${md(c.name)}${c.categories.length ? ` — ${md(c.categories.join(", "))}` : ""}`);
		lines.push("");
	}

	if (input.bot?.length) {
		lines.push("## Bot detection", "");
		for (const line of input.bot) lines.push(`- ${md(line)}`);
		lines.push("");
	}

	if (input.verdict.hits.length) {
		lines.push("## Everything that acted", "", "| Action | Rule | Source |", "| --- | --- | --- |");
		for (const h of input.verdict.hits) lines.push(`| ${md(h.action)} | ${md(h.description || h.ruleId)} | ${md(h.source)} |`);
		lines.push("");
	}

	lines.push(`_Generated by Flarelens, ${(input.generatedAt ?? new Date()).toISOString()}. Request analytics are sampled; counts are Cloudflare's sample-adjusted figures._`, "");
	return lines.join("\n");
}

export function downloadMarkdown(filename: string, markdown: string): void {
	const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

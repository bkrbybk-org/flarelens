import type { EvalItem } from "./evaluation";
import { titleCase } from "./format";
import { isBlocking, type RayHit, type RayVerdict } from "./ray-verdict";

/**
 * The second opinion on one request: was the verdict right?
 *
 * A blocked request raises the false-positive question — what matched, whether Cloudflare's own
 * scores agree, and the smallest change that would let requests like it through. A request that
 * got through raises the false-negative one — what let it pass (a skip, a rule that only logs, a
 * disabled rule), whether the scores say it looked malicious, and a rule that would catch it.
 *
 * Everything here is advice drawn from one request; the expressions are drafts to paste into the
 * dashboard and test, not changes this read-only app makes.
 */

export interface ReviewPoint {
	/** "cause": what decided the outcome. "signal": a score that agrees or disagrees. "note": context. */
	kind: "cause" | "signal" | "note";
	text: string;
}

export interface ReviewSuggestion {
	title: string;
	/** Where the change goes, in dashboard terms. */
	where: string;
	action: string;
	expression: string;
}

export interface RayReview {
	question: "false-positive" | "false-negative";
	title: string;
	points: ReviewPoint[];
	suggestions: ReviewSuggestion[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A Rules-language string literal. */
export function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Host and path of this request, as an expression that matches requests like it. */
export function requestExpression(request: Record<string, unknown>): string {
	const parts: string[] = [];
	const host = str(request.clientRequestHTTPHost);
	const path = str(request.clientRequestPath);
	if (host) parts.push(`http.host eq ${quote(host)}`);
	if (path) parts.push(`http.request.uri.path eq ${quote(path)}`);
	return parts.join(" and ") || "true";
}

/** matched_vars from the event a rule recorded, when payload logging captured it. */
function matchedFields(events: Record<string, unknown>[], ruleId: string): string | null {
	for (const event of events) {
		if (str(event.ruleId) !== ruleId || !Array.isArray(event.metadata)) continue;
		for (const entry of event.metadata as { key?: string; value?: unknown }[]) {
			if (entry?.key === "matched_vars" && typeof entry.value === "string") return entry.value;
		}
	}
	return null;
}

/** Every rule in the evaluation order by id, with where it sits. */
function placements(verdict: RayVerdict) {
	const byId = new Map<string, { item: EvalItem; where: string }>();
	for (const { stage, items } of verdict.stages) {
		const phase = stage.phaseLabel.toLowerCase();
		for (const { item, innerHits } of items) {
			byId.set(item.row.id, { item, where: `${stage.scope} ${phase}, #${item.position}` });
			for (const h of innerHits) byId.set(h.item.row.id, { item: h.item, where: `${stage.scope} ${phase}, inside "${item.target?.name}"` });
		}
	}
	return byId;
}

const describeHit = (h: RayHit) => `"${h.description || h.ruleId}"`;

/** Cloudflare's own scores for the request, read as for or against an attack. */
function scoreSignals(request: Record<string, unknown>) {
	const bad: { text: string; field: string; expression: string }[] = [];
	const clean: string[] = [];
	const attack = num(request.wafAttackScore);
	if (attack !== null && attack > 0) {
		if (attack <= 20) bad.push({ text: `WAF attack score ${attack} — Cloudflare's ML rates it a likely attack (1–20).`, field: "cf.waf.score", expression: "cf.waf.score le 20" });
		else if (attack >= 80) clean.push(`WAF attack score ${attack} — rated clean.`);
	}
	const bot = num(request.botScore);
	if (bot !== null && bot > 0) {
		if (bot < 30) bad.push({ text: `Bot score ${bot} — likely automated (under 30).`, field: "cf.bot_management.score", expression: "cf.bot_management.score lt 30" });
		else if (bot >= 50) clean.push(`Bot score ${bot} — likely human.`);
	}
	const injection = num(request.firewallForAiInjectionScore);
	if (injection !== null && injection > 0 && injection < 20) {
		bad.push({ text: `Prompt injection score ${injection} — likely an injection attempt.`, field: "cf.llm.prompt.injection_score", expression: "cf.llm.prompt.injection_score lt 20" });
	}
	const malicious = num(request.contentScanNumMaliciousObj);
	if (malicious !== null && malicious > 0) {
		bad.push({
			text: `${malicious} malicious ${malicious === 1 ? "object" : "objects"} in the upload.`,
			field: "cf.waf.content_scan.has_malicious_obj",
			expression: "cf.waf.content_scan.has_malicious_obj",
		});
	}
	return { bad, clean };
}

export function reviewRay(verdict: RayVerdict, request: Record<string, unknown> = {}, events: Record<string, unknown>[] = []): RayReview {
	const { bad, clean } = scoreSignals(request);
	const like = requestExpression(request);
	const outcome = verdict.outcome && isBlocking(verdict.outcome.action) ? verdict.outcome : null;
	const points: ReviewPoint[] = [];
	const suggestions: ReviewSuggestion[] = [];

	if (verdict.decidedBy || outcome) {
		const decided = verdict.decidedBy;
		if (decided) {
			const { item, stage, hit } = decided;
			const phase = stage.phaseLabel.toLowerCase();
			points.push({ kind: "cause", text: `${describeHit(hit)} decided it — ${stage.scope} ${phase}${item.row.ruleset ? `, ruleset "${item.row.ruleset}"` : ""}, rule #${item.position}.` });
			const fields = matchedFields(events, hit.ruleId);
			if (fields) points.push({ kind: "cause", text: `It matched on: ${fields}.` });
			if (stage.phase === "http_request_firewall_managed") {
				suggestions.push({
					title: "Exempt requests like this one from this managed rule",
					where: `${stage.scope} managed rules — an exception placed above the deployment that runs "${item.row.ruleset}"`,
					action: `Skip → specific rules: ${item.row.name} (${item.row.id})`,
					expression: like,
				});
			} else if (item.row.expression) {
				suggestions.push({
					title: "Narrow the rule so requests like this one no longer match",
					where: `${stage.scope} ${phase} — edit #${item.position} "${item.row.name}"`,
					action: `${titleCase(hit.action)} (unchanged)`,
					expression: `(${item.row.expression}) and not (${like})`,
				});
			}
			if (stage.phase === "http_ratelimit") {
				points.push({ kind: "note", text: "A rate limit blocks on volume, not content — for a legitimate client, a higher threshold or a narrower counting characteristic may fit better than an exception." });
			}
		} else if (outcome) {
			const outside = verdict.outside.find((h) => h.source === outcome.source);
			points.push({
				kind: "cause",
				text: `Decided outside the WAF rules, by ${outcome.source}${outside ? ` (${describeHit(outside)})` : ""}. Tune that feature — security level, IP access rules, Bot Fight Mode — rather than a WAF rule.`,
			});
		}
		for (const c of clean) points.push({ kind: "signal", text: `${c} Supports a false positive.` });
		for (const b of bad) points.push({ kind: "signal", text: `${b.text} The block may well be right.` });
		const title = clean.length && !bad.length ? "Blocked, though Cloudflare's scores call it legitimate — likely a false positive" : "Blocked — is this a false positive?";
		return { question: "false-positive", title, points, suggestions };
	}

	const placed = placements(verdict);
	for (const hit of verdict.hits) {
		const at = placed.get(hit.ruleId);
		const where = at ? ` (${at.where})` : "";
		if (hit.action.toLowerCase() === "skip") {
			const expr = at?.item.row.expression;
			points.push({ kind: "cause", text: `${describeHit(hit)}${where} skipped later rules for this request — the first place to look if it should have been stopped.${expr ? ` Its expression: ${expr}` : ""}` });
		} else if (!hit.terminating) {
			const override = at?.item.effective.overriddenBy ? ` The deployment's ${at.item.effective.overriddenBy} override sets that action.` : "";
			points.push({ kind: "cause", text: `${describeHit(hit)}${where} matched but only did "${hit.action}".${override} Block or Managed Challenge would have stopped this request.` });
		}
	}
	const disabled = verdict.stages.flatMap(({ items }) => items.filter(({ item }) => !item.target && !item.row.enabled).map(({ item }) => item.row.name));
	if (disabled.length) {
		points.push({ kind: "note", text: `${disabled.length} disabled ${disabled.length === 1 ? "rule" : "rules"} never ran: ${disabled.slice(0, 5).join(", ")}${disabled.length > 5 ? "…" : ""}.` });
	}
	for (const b of bad) {
		points.push({ kind: "signal", text: `${b.text} No rule acted on it.` });
		suggestions.push({ title: `Act on ${b.field}`, where: "Zone custom rules — near the top, below any skip rules you trust", action: "Block or Managed Challenge", expression: b.expression });
	}
	for (const c of clean) points.push({ kind: "signal", text: c });
	if (!verdict.hits.length && !bad.length) points.push({ kind: "note", text: "Nothing matched and Cloudflare's scores don't flag it — no current rule targets requests like this one." });
	const status = num(request.edgeResponseStatus);
	if (status !== null) points.push({ kind: "note", text: `Served with HTTP ${status}.` });
	const ip = str(request.clientIP);
	suggestions.push({ title: "Block requests like this one", where: "Zone custom rules", action: "Block", expression: ip ? `${like} and ip.src eq ${ip}` : like });
	const title = bad.length ? "Let through, though Cloudflare's scores flag it — likely a false negative" : "Let through — is this a false negative?";
	return { question: "false-negative", title, points, suggestions };
}

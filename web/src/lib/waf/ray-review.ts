import type { EvalItem } from "./evaluation";
import { titleCase } from "./format";
import { isBlocking, type RayHit, type RayVerdict } from "./ray-verdict";
import type { RuleMetaMap } from "./types";

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
	/** The match expression; empty for a change that has none (a deployment override). */
	expression: string;
	/** What else the change reaches, when that is more than requests like this one. */
	caution?: string;
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
const matchedFields = (events: Record<string, unknown>[], ruleId: string) => eventMetadata(events, "matched_vars", ruleId);

/** One metadata value from the first event that carries it. */
function eventMetadata(events: Record<string, unknown>[], key: string, ruleId?: string): string | null {
	for (const event of events) {
		if (ruleId && str(event.ruleId) !== ruleId) continue;
		if (!Array.isArray(event.metadata)) continue;
		for (const entry of event.metadata as { key?: string; value?: unknown }[]) {
			if (entry?.key === key && typeof entry.value === "string") return entry.value;
		}
	}
	return null;
}

export interface OwaspBreakdown {
	/** The scoring rule's event (949110 and friends). */
	ruleId: string;
	action: string;
	total: number;
	/** The deployment's threshold, when an override sets one. */
	threshold?: number;
	/** Rules that added to the score, named from the ruleset where it knows them. */
	contributors: { id: string; name: string; categories: string[] }[];
}

/**
 * The OWASP Core Ruleset blocks on a total, not on one rule: each matching rule adds to an anomaly
 * score and a scoring rule acts once it crosses the threshold. Cloudflare records that scoring
 * rule's event with `score_total` and `score_rules` (the contributing rule ids) in its metadata —
 * enough to name the contributors, though not each one's share.
 */
export function owaspBreakdown(verdict: RayVerdict, events: Record<string, unknown>[], ruleMeta: RuleMetaMap = {}): OwaspBreakdown | null {
	for (const event of events) {
		const ruleId = str(event.ruleId);
		const total = Number(eventMetadata([event], "score_total"));
		if (!ruleId || !Number.isFinite(total) || eventMetadata([event], "score_total") === null) continue;
		let ids: string[] = [];
		try {
			const parsed = JSON.parse(eventMetadata([event], "score_rules") ?? "[]");
			if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
		} catch {
			// Unreadable list: the total still stands on its own.
		}
		let threshold: number | undefined;
		for (const { items } of verdict.stages) {
			for (const { item } of items) {
				const inner = item.target?.items.find((i) => i.row.id === ruleId);
				if (inner?.effective.scoreThreshold !== undefined) threshold = inner.effective.scoreThreshold;
			}
		}
		return {
			ruleId,
			action: str(event.action),
			total,
			threshold,
			contributors: ids.map((id) => ({ id, name: ruleMeta[id]?.name || id, categories: ruleMeta[id]?.categories ?? [] })),
		};
	}
	return null;
}

/** Bot management's view of the request, in sentences. Empty when the plan has no bot data. */
export function botSummary(request: Record<string, unknown>): string[] {
	const out: string[] = [];
	const score = num(request.botScore);
	const source = str(request.botScoreSrcName);
	if (score !== null && score > 0) {
		const band = score === 1 ? "automated" : score < 30 ? "likely automated" : "likely human";
		out.push(`Bot score ${score} — ${band}${source ? `, from ${source}` : ""}.`);
	}
	const verified = str(request.verifiedBotCategory);
	if (verified) out.push(`A verified bot: ${verified}. Rules can let these through with cf.bot_management.verified_bot.`);
	const decision = str(request.botManagementDecision);
	if (decision && decision !== "other") out.push(`Bot management decision: ${decision}.`);
	const js = str(request.jsDetectionPassed);
	// "Unknown" is what a zone without JavaScript detections reports for every request.
	if (js && js.toLowerCase() !== "unknown") out.push(`JavaScript detection: ${js}.`);
	const ids = Array.isArray(request.botDetectionIds) ? request.botDetectionIds : [];
	if (ids.length) out.push(`Detection IDs: ${ids.join(", ")} — what rules match with cf.bot_management.detection_ids.`);
	const tags = Array.isArray(request.botDetectionTags) ? request.botDetectionTags : [];
	if (tags.length) out.push(`Detection tags: ${tags.join(", ")}.`);
	return out;
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
		if (bot < 30) bad.push({ text: `Bot score ${bot} — ${bot === 1 ? "automated" : "likely automated (under 30)"}.`, field: "cf.bot_management.score", expression: "cf.bot_management.score lt 30" });
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

export function reviewRay(
	verdict: RayVerdict,
	request: Record<string, unknown> = {},
	events: Record<string, unknown>[] = [],
	ruleMeta: RuleMetaMap = {},
): RayReview {
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
				const where = `${stage.scope} managed rules — an exception placed above the deployment that runs "${item.row.ruleset}"`;
				const owasp = owaspBreakdown(verdict, events, ruleMeta);
				if (owasp && owasp.ruleId === hit.ruleId) {
					points.push({
						kind: "cause",
						text: `OWASP anomaly score ${owasp.total}${owasp.threshold !== undefined ? ` against the deployment's threshold of ${owasp.threshold}` : " — over the deployment's threshold (not overridden, so the ruleset default applies)"}, from ${owasp.contributors.length} contributing ${owasp.contributors.length === 1 ? "rule" : "rules"}. No single rule blocked it.`,
					});
					if (owasp.contributors.length) {
						suggestions.push({
							title: "Exempt requests like this one from the rules that scored it",
							where,
							action: `Skip → specific rules: ${owasp.contributors.slice(0, 10).map((c) => c.id).join(", ")}${owasp.contributors.length > 10 ? "…" : ""}`,
							expression: like,
						});
					}
					suggestions.push({
						title: "Raise the anomaly score threshold",
						where: `${stage.scope} managed rules — configure the OWASP deployment`,
						action: `Score threshold above ${owasp.total} (for example a lower sensitivity level)`,
						expression: "",
						caution: "Applies to all traffic the deployment covers, not just requests like this one.",
					});
				} else {
					suggestions.push({ title: "Exempt requests like this one from this managed rule", where, action: `Skip → specific rules: ${item.row.name} (${item.row.id})`, expression: like });
					suggestions.push({
						title: `Exempt requests like this one from the whole "${item.row.ruleset}" ruleset`,
						where,
						action: `Skip → specific managed rulesets: ${item.row.ruleset}`,
						expression: like,
						caution: "Broader: no rule of this ruleset runs on these requests.",
					});
					suggestions.push({
						title: "Set this rule to Log in the deployment",
						where: `${stage.scope} managed rules — configure the deployment that runs "${item.row.ruleset}", rule override`,
						action: `${item.row.name} → Log`,
						expression: "",
						caution: "Applies to all traffic: the rule stops blocking anything, anywhere this deployment runs.",
					});
					for (const category of (item.row.categories ?? []).slice(0, 3)) {
						suggestions.push({
							title: `Turn off the "${category}" category`,
							where: `${stage.scope} managed rules — configure the deployment that runs "${item.row.ruleset}", category override`,
							action: `Category ${category} → disabled`,
							expression: "",
							caution: "Only where the application does not use what the category protects (a WordPress rule on a site with no WordPress, say). Applies to all traffic.",
						});
					}
				}
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
		const verifiedBot = str(request.verifiedBotCategory);
		if (verifiedBot) {
			points.push({ kind: "signal", text: `A verified bot (${verifiedBot}). If it should be allowed, exempt verified bots rather than this one client.` });
			suggestions.push({ title: "Let verified bots through", where: "Zone custom rules — a skip rule above the one that blocked", action: "Skip", expression: "cf.bot_management.verified_bot" });
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
		if (!at && hit.action.toLowerCase() !== "skip") {
			// AI Labyrinth, security level, IP access rules: not a WAF rule whose action can be changed.
			points.push({ kind: "note", text: `${describeHit(hit)} acted outside the WAF rules with "${hit.action}" (${hit.source}).` });
		} else if (hit.action.toLowerCase() === "skip") {
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

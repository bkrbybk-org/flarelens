import { aggregateRules } from "./aggregate";
import { buildEvaluationOrder, type EvalItem, type EvalStage } from "./evaluation";
import type { RuleMetaMap } from "./types";

/**
 * "Why was this request blocked?" — one request's firewall matches laid over the zone's rules in
 * the order Cloudflare evaluates them (see evaluation.ts).
 *
 * Hits are placed by evaluation order, not by the events' `matchIndex`: on the account this was
 * built against a managed-phase match carried index 0 and a custom-phase match on the same request
 * index 3, so `matchIndex` is not the phase order.
 *
 * What the data does and does not say. A firewall event exists for every rule that matched and
 * acted (including log and skip). A rule with no event either did not match or was never reached;
 * the page calls that "no match recorded", and calls everything after the deciding rule "not
 * reached" — evaluation stops at a terminating action. Which of several deployments of one managed
 * ruleset ran depends on their expressions; the first one in order is credited.
 */

const TERMINATING = new Set(["block", "challenge", "managed_challenge", "js_challenge", "jschallenge", "managedchallenge"]);

/**
 * A request outcome that stopped the request. Cloudflare also reports "log" and "skip" as a
 * request's security action; neither blocked anything.
 */
const BLOCKING = new Set([...TERMINATING, "connection_close", "forceconnectionclose"]);
export const isBlocking = (action: string) => BLOCKING.has(action.toLowerCase());

export interface RayHit {
	ruleId: string;
	rulesetId: string;
	action: string;
	source: string;
	description: string;
	terminating: boolean;
}

export type ItemState = "decided" | "matched" | "not-reached" | "no-match";

export interface ItemView {
	item: EvalItem;
	state: ItemState;
	hit?: RayHit;
	/** For an execute rule: the rules inside it that this request matched, with their state. */
	innerHits: { item: EvalItem; state: ItemState; hit: RayHit }[];
}

export interface StageView {
	stage: EvalStage;
	items: ItemView[];
}

export interface RayVerdict {
	/** The request's own final security outcome, when the request row carried it. */
	outcome: { action: string; source: string } | null;
	hits: RayHit[];
	/** The rule that ended evaluation, when one in the rulesets did. */
	decidedBy: { stage: EvalStage; item: EvalItem; hit: RayHit } | null;
	stages: StageView[];
	/** Matches from outside the rulesets (AI Labyrinth, security level, IP access rules…). */
	outside: RayHit[];
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

export function toHits(events: Record<string, unknown>[]): RayHit[] {
	return events.map((e) => {
		const action = str(e.action);
		return {
			ruleId: str(e.ruleId),
			rulesetId: str(e.rulesetId),
			action,
			source: str(e.source),
			description: str(e.description),
			terminating: TERMINATING.has(action.toLowerCase()),
		};
	});
}

export function buildRayVerdict(events: Record<string, unknown>[], request: Record<string, unknown> | undefined, ruleMeta: RuleMetaMap): RayVerdict {
	const hits = toHits(events);
	const hitByRule = new Map(hits.filter((h) => h.ruleId).map((h) => [h.ruleId, h]));
	const order = buildEvaluationOrder(ruleMeta, aggregateRules([], ruleMeta));

	const placed = new Set<string>();
	let decidedBy: RayVerdict["decidedBy"] = null;
	let stopped = false;

	// A recorded match always shows as one — Cloudflare saw that rule act — even where the order
	// says evaluation had stopped; the data outranks the model.
	const stateFor = (hit: RayHit | undefined): ItemState => {
		if (!hit) return stopped ? "not-reached" : "no-match";
		return hit.terminating && !decidedBy ? "decided" : "matched";
	};

	const stages: StageView[] = order.stages.map((stage) => ({
		stage,
		items: stage.items.map((item) => {
			if (item.target) {
				const innerHits: ItemView["innerHits"] = [];
				for (const inner of item.target.items) {
					const hit = hitByRule.get(inner.row.id);
					if (!hit) continue;
					const state = stateFor(hit);
					innerHits.push({ item: inner, state, hit });
					if (state === "decided" || state === "matched") placed.add(hit.ruleId);
					if (state === "decided") {
						decidedBy = { stage, item: inner, hit };
						stopped = true;
					}
				}
				const state: ItemState = innerHits.some((h) => h.state === "decided")
					? "decided"
					: innerHits.some((h) => h.state === "matched")
						? "matched"
						: stopped && innerHits.length === 0
							? "not-reached"
							: "no-match";
				return { item, state, innerHits };
			}
			const hit = hitByRule.get(item.row.id);
			const state = stateFor(hit);
			if (hit && (state === "decided" || state === "matched")) placed.add(hit.ruleId);
			if (state === "decided" && hit) {
				decidedBy = { stage, item, hit };
				stopped = true;
			}
			return { item, state, hit, innerHits: [] };
		}),
	}));

	const outcomeAction = str(request?.securityAction);
	const outcomeSource = str(request?.securitySource);
	return {
		outcome: outcomeAction && outcomeAction !== "unknown" ? { action: outcomeAction, source: outcomeSource } : null,
		hits,
		decidedBy,
		stages,
		outside: hits.filter((h) => !placed.has(h.ruleId)),
	};
}

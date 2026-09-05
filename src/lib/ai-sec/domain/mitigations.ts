/**
 * Turns "what fired" into "what rule would stop it".
 *
 * The dashboard already answers what was detected; this answers what is still getting through.
 * Every recommendation carries the count it would have covered and the count already mitigated,
 * so the gap between the two is the reason to write the rule — a signal that fired 300 times
 * with 300 already blocked needs no action, and one with 0 blocked is the whole point.
 *
 * WHY THE EXPRESSIONS ARE CONSERVATIVE. The output of this module is meant to be pasted into a
 * production WAF. A wrong expression is worse than no expression: it either fails to parse, or
 * parses and silently matches nothing. So only field names this repository has already verified
 * against real Cloudflare behaviour are emitted:
 *
 *   cf.llm.prompt.injection_score            (src/domain/catalog.ts, src/views/setup.tsx)
 *   cf.llm.prompt.pii_detected               (observed in matched_vars, docs/graphql-fields.md)
 *   cf.llm.prompt.pii_categories[*]          (observed in matched_vars, docs/graphql-fields.md)
 *   cf.llm.prompt.unsafe_topic_detected      (src/views/setup.tsx)
 *   cf.llm.prompt.unsafe_topic_categories[*] (src/views/setup.tsx)
 *
 * Custom topics deliberately get NO expression. They are a real detection with a real KPI here,
 * but no rules-language field name for them has been verified — not in the Cloudflare docs this
 * project cites, not in any matched_vars payload observed, and not in the GraphQL schema probe
 * (which only ever proves the *analytics* field name, never the *rules-language* one). Guessing
 * would produce exactly the silent-no-match failure described above, so the recommendation says
 * where to configure it instead of inventing a field.
 */

import { categorySeverity, INJECTION_ATTACK_THRESHOLD, piiLabel, unsafeTopicLabel, type CategoryInfo } from './catalog';

export type MitigationSeverity = CategoryInfo['severity'];

/**
 * Per-signal input, computed by transform.ts where the full event list lives. Kept as a plain
 * data shape rather than taking RawEvent[] so this module has no dependency on transform.ts —
 * transform.ts calls into here, and a cycle would be the alternative.
 */
export interface SignalStat {
	kind: 'injection' | 'pii' | 'unsafe' | 'custom';
	/** API code for pii/unsafe (e.g. CREDIT_CARD, S4); the topic label for custom; '' for injection. */
	code: string;
	/** Weighted count of flagged requests carrying this signal. */
	count: number;
	/** How many of those already hit a terminating action (block/challenge). */
	blocked: number;
}

export interface Mitigation {
	id: string;
	/**
	 * Same vocabulary as SignalStat.kind, carried through unparsed. The view needs it to build a
	 * per-row drill-down link into the events page, and re-deriving it by splitting `id` on ':'
	 * would break the moment a custom topic code itself contains a colon.
	 */
	kind: SignalStat['kind'];
	/** Same vocabulary as SignalStat.code, carried through unparsed for the same reason as `kind`. */
	code: string;
	/** Human title, e.g. "Unsafe topic: Child sexual exploitation". */
	title: string;
	severity: MitigationSeverity;
	/** Requests carrying this signal in the window. */
	count: number;
	/** How many were already stopped by an existing rule. */
	blocked: number;
	/** count - blocked: what a new rule would actually change. This drives the ordering. */
	unmitigated: number;
	/**
	 * Cloudflare rules-language expression, ready to paste into a custom rule. Null when this
	 * project has not verified a field name for the signal — see the module comment.
	 */
	expression: string | null;
	/** Suggested rule action. */
	action: 'Block' | 'Managed Challenge' | 'Log';
	/** One or two sentences on why this rule and this action. */
	rationale: string;
}

const SEVERITY_ORDER: Record<MitigationSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Action follows severity, not volume. Blocking a low-severity category because it happens to be
 * noisy is how a dashboard talks someone into breaking their own traffic — `Location` and `URL`
 * are the highest-volume PII categories on live traffic and are almost always benign.
 */
function actionFor(severity: MitigationSeverity): Mitigation['action'] {
	switch (severity) {
		case 'critical':
			return 'Block';
		case 'high':
			return 'Managed Challenge';
		default:
			return 'Log';
	}
}

function piiExpression(code: string): string {
	return `(cf.llm.prompt.pii_detected and any(cf.llm.prompt.pii_categories[*] in {"${code}"}))`;
}

function unsafeExpression(code: string): string {
	return `(cf.llm.prompt.unsafe_topic_detected and any(cf.llm.prompt.unsafe_topic_categories[*] in {"${code}"}))`;
}

function injectionExpression(): string {
	return `(cf.llm.prompt.injection_score lt ${INJECTION_ATTACK_THRESHOLD})`;
}

function toMitigation(stat: SignalStat): Mitigation | null {
	const unmitigated = Math.max(stat.count - stat.blocked, 0);

	switch (stat.kind) {
		case 'injection': {
			const severity: MitigationSeverity = 'critical';
			return {
				id: 'injection',
				kind: stat.kind,
				code: stat.code,
				title: `Prompt injection (score below ${INJECTION_ATTACK_THRESHOLD})`,
				severity,
				count: stat.count,
				blocked: stat.blocked,
				unmitigated,
				expression: injectionExpression(),
				action: actionFor(severity),
				rationale:
					`The score is inverted — ${INJECTION_ATTACK_THRESHOLD} and below is Cloudflare's own "likely attack" band, ` +
					'and 100 means the request was never scored rather than that it is safe. Match on the band, never on 100.',
			};
		}
		case 'pii': {
			const severity = categorySeverity('pii', stat.code);
			return {
				id: `pii:${stat.code}`,
				kind: stat.kind,
				code: stat.code,
				title: `PII in prompt: ${piiLabel(stat.code)}`,
				severity,
				count: stat.count,
				blocked: stat.blocked,
				unmitigated,
				expression: piiExpression(stat.code),
				action: actionFor(severity),
				rationale:
					severity === 'critical'
						? 'A prompt carrying this category is a data-loss event whether or not the model answers, because the value has already left the user and reached a third-party provider.'
						: 'Log first and read the matches before enforcing — this category has a high false-positive rate on ordinary prose.',
			};
		}
		case 'unsafe': {
			const severity = categorySeverity('topic', stat.code);
			return {
				id: `unsafe:${stat.code}`,
				kind: stat.kind,
				code: stat.code,
				title: `Unsafe topic: ${unsafeTopicLabel(stat.code)} (${stat.code})`,
				severity,
				count: stat.count,
				blocked: stat.blocked,
				unmitigated,
				expression: unsafeExpression(stat.code),
				action: actionFor(severity),
				rationale:
					severity === 'critical'
						? 'A category in this tier carries legal and safety exposure on its own; blocking at the edge keeps the prompt out of the model and out of your provider logs.'
						: 'Worth a rule once you have read a sample — enforce only after confirming the matches are not ordinary product questions.',
			};
		}
		case 'custom': {
			return {
				id: `custom:${stat.code}`,
				kind: stat.kind,
				code: stat.code,
				title: `Custom topic: ${stat.code}`,
				// Custom topics are defined by whoever wrote them, so this module cannot rate them.
				severity: 'high',
				count: stat.count,
				blocked: stat.blocked,
				unmitigated,
				expression: null,
				action: 'Log',
				rationale:
					'You defined this topic, so you already decided it matters. It is enforced through the Firewall for AI custom topic configuration rather than a hand-written expression — this dashboard has not verified a rules-language field name for custom topics and will not guess one.',
			};
		}
	}
}

/**
 * Ranked recommendations. Sorted by how much a rule would actually change — unmitigated volume —
 * within severity tier, so a critical signal that is already fully blocked sinks below a high one
 * that is entirely getting through.
 */
export function buildMitigations(stats: SignalStat[], limit = 8): Mitigation[] {
	return stats
		.filter((s) => s.count > 0)
		.map(toMitigation)
		.filter((m): m is Mitigation => m !== null)
		.sort(
			(a, b) =>
				SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.unmitigated - a.unmitigated || b.count - a.count,
		)
		.slice(0, limit);
}

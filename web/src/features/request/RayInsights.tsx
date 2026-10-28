import { BADGE, BADGE_NEUTRAL, CARD, MUTED, SECTION_TITLE } from "../../lib/ui";
import { decisiveLeaves, unknownReasons, type ExplainNode, type Explanation, type Tri } from "../../lib/waf/explain-expr";
import { titleCase } from "../../lib/waf/format";
import { isBlocking } from "../../lib/waf/ray-verdict";
import type { OwaspBreakdown } from "../../lib/waf/ray-review";
import type { RequestContext } from "./types";

/**
 * The Request Trace panels that go past "which rule": why an expression matched or not, the OWASP
 * score behind a block, bot management's view, and the request's surroundings (what a fix would
 * affect, the rule's other hits, the client's timeline).
 */

const fmt = (n: number) => n.toLocaleString();

const TRI_STYLE: Record<string, string> = {
	true: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	false: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
	unknown: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};
const TRI_LABEL: Record<string, string> = { true: "true", false: "false", unknown: "can't tell" };

function TriBadge({ value }: { value: Tri }) {
	return <span className={`${BADGE} shrink-0 ${TRI_STYLE[String(value)]}`}>{TRI_LABEL[String(value)]}</span>;
}

const GROUP_LABEL = { and: "all of", or: "any of", xor: "an odd number of", not: "not" } as const;

function Node({ node }: { node: ExplainNode }) {
	if (node.kind === "leaf") {
		return (
			<li className="flex flex-wrap items-baseline gap-2">
				<TriBadge value={node.result} />
				<code className="min-w-0 break-all">{node.text}</code>
				{node.actual && <span className={`text-xs ${MUTED}`}>request: {node.actual}</span>}
				{node.result === "unknown" && node.reason && <span className="text-xs text-amber-700 dark:text-amber-400">{node.reason}</span>}
			</li>
		);
	}
	return (
		<li>
			<div className="flex items-center gap-2">
				<TriBadge value={node.result} />
				<span className={`text-xs font-medium ${MUTED}`}>{GROUP_LABEL[node.kind]}</span>
			</div>
			<ul className="ml-3 mt-1 space-y-1 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
				{node.children.map((child, i) => (
					<Node key={i} node={child} />
				))}
			</ul>
		</li>
	);
}

/** An expression's condition tree with each condition's result and the request's value. */
export function ExpressionExplain({ explanation }: { explanation: Explanation }) {
	if (explanation.error) return <p className={`text-xs ${MUTED}`}>Could not read this expression: {explanation.error}.</p>;
	if (!explanation.root) return null;
	return (
		<ul className="space-y-1 text-xs">
			<Node node={explanation.root} />
		</ul>
	);
}

/** One line: why it matched, why not, or what is missing to tell. */
export function explainSummary(explanation: Explanation): string {
	if (explanation.error) return "expression not readable here";
	if (explanation.result === "unknown") {
		const reasons = unknownReasons(explanation.root);
		return `can't tell — ${reasons[0] ?? "a condition this page cannot evaluate"}`;
	}
	const leaves = decisiveLeaves(explanation.root, explanation.result).slice(0, 2);
	const because = leaves.map((l) => (l.actual ? `${l.text} (${l.actual})` : l.text)).join("; ");
	return explanation.result ? `matches: ${because || "always true"}` : `no match: ${because}`;
}

/**
 * The state of a rule that recorded no event, read from its expression. A "no match" proven by
 * the request's own values is the useful case; an expression that evaluates true with no event is
 * flagged, since a field the record lacks must have differed (or an earlier skip applied).
 */
export function RuleExplainChip({
	expression,
	explanation,
	state,
	terminating,
	deployment = false,
	ranRules = false,
	enabled = true,
}: {
	/** The rule's condition as written. */
	expression: string;
	explanation: Explanation;
	state: "decided" | "matched" | "no-match" | "not-reached";
	terminating: boolean;
	/** An execute rule: its expression decides whether the ruleset runs, and it records no event itself. */
	deployment?: boolean;
	/** For a deployment: whether any rule inside it recorded a match. */
	ranRules?: boolean;
	enabled?: boolean;
}) {
	const summary = explainSummary(explanation);
	const reached = state !== "not-reached";
	const recorded = state === "decided" || state === "matched";
	let label: string;
	let tone = MUTED;
	if (!enabled && !recorded) {
		label = "disabled — never runs";
	} else if (deployment) {
		if (ranRules) label = "ran this ruleset — matches shown below";
		else if (explanation.result === true) label = reached ? "ran this ruleset — none of its rules recorded a match" : "would run this ruleset";
		else if (explanation.result === false) label = `did not run: ${summary.replace(/^no match: /, "")}`;
		else label = summary;
	} else if (recorded) {
		// Cloudflare saw it match; the record can only fail to show why, never contradict it.
		label = explanation.result === true ? summary : "matched — on a field the request record does not show";
	} else if (explanation.result === true) {
		label = reached ? "expression matches, but no event was recorded" : terminating ? "would also match — a fix above it would hand the request to this rule" : "would also match";
		tone = reached ? "text-amber-700 dark:text-amber-400" : terminating ? "text-red-600 dark:text-red-400" : MUTED;
	} else label = summary;
	return (
		<details className="mt-0.5 ml-9 text-xs">
			<summary className={`cursor-pointer ${tone}`}>
				<span className="font-medium">Condition</span> · {label}
			</summary>
			<div className="mt-1 space-y-2">
				<code className="block break-all rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-950">{expression}</code>
				<ExpressionExplain explanation={explanation} />
			</div>
		</details>
	);
}

const ACTION_TONE: Record<string, string> = {
	block: "bg-red-500/15 text-red-600 dark:text-red-400",
	challenge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	managed_challenge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	js_challenge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	log: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
	execute: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
};

/**
 * What the rule does when it matches, as it actually runs: a deployment's override (rule,
 * category or ruleset-wide) wins over the rule's own action, and the tooltip says which.
 */
export function ActionBadge({ action, overriddenBy, defaultAction }: { action: string; overriddenBy?: string | null; defaultAction?: string }) {
	const key = action.toLowerCase();
	const label = key === "execute" ? "Execute" : titleCase(action || "—");
	const title = overriddenBy && defaultAction ? `Set by the deployment's ${overriddenBy} override; the rule's own action is ${titleCase(defaultAction)}` : undefined;
	return (
		<span className={`${BADGE} shrink-0 ${ACTION_TONE[key] ?? BADGE_NEUTRAL}`} title={title}>
			{label}
			{overriddenBy ? " *" : ""}
		</span>
	);
}

export function OwaspPanel({ breakdown }: { breakdown: OwaspBreakdown }) {
	return (
		<section className={CARD}>
			<h2 className={`mb-1 ${SECTION_TITLE}`}>OWASP anomaly score: {breakdown.total}</h2>
			<p className={`mb-3 text-xs ${MUTED}`}>
				The OWASP Core Ruleset acts on a total: every matching rule adds to the score, and the scoring rule {titleCase(breakdown.action)}s
				once it reaches the threshold
				{breakdown.threshold !== undefined ? ` — ${breakdown.threshold} on this deployment` : " (not overridden on this deployment, so the ruleset default applies)"}.
				Cloudflare records which rules contributed, not how much each added.
			</p>
			{breakdown.contributors.length ? (
				<ol className="space-y-1 text-sm">
					{breakdown.contributors.map((c) => (
						<li key={c.id} className="flex flex-wrap items-baseline gap-2">
							<span className="min-w-0 flex-1 break-words">{c.name}</span>
							{c.categories.slice(0, 3).map((cat) => (
								<span key={cat} className={BADGE_NEUTRAL}>{cat}</span>
							))}
						</li>
					))}
				</ol>
			) : (
				<p className={`text-sm ${MUTED}`}>The event did not list the contributing rules.</p>
			)}
		</section>
	);
}

export function BotPanel({ lines }: { lines: string[] }) {
	return (
		<section className={CARD}>
			<h2 className={`mb-2 ${SECTION_TITLE}`}>Bot detection</h2>
			<ul className="space-y-1 text-sm">
				{lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</section>
	);
}

const ACTION_LABEL: Record<string, string> = { unknown: "served (no action)", "": "served (no action)" };
const actionLabel = (a: string) => ACTION_LABEL[a] ?? titleCase(a);

function Breakdown({ counts }: { counts: Record<string, number> }) {
	const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
	if (!entries.length) return null;
	return (
		<span className="flex flex-wrap gap-1">
			{entries.map(([action, count]) => (
				<span key={action} className={BADGE_NEUTRAL}>
					{actionLabel(action)} {fmt(count)}
				</span>
			))}
		</span>
	);
}

function TopList({ title, rows }: { title: string; rows: { value: string; count: number }[] }) {
	if (!rows.length) return null;
	return (
		<div>
			<h4 className={`mb-1 text-xs font-medium ${MUTED}`}>{title}</h4>
			<ol className="space-y-0.5 text-xs">
				{rows.map((r) => (
					<li key={r.value} className="flex gap-2">
						<span className="min-w-0 flex-1 truncate font-mono" title={r.value}>{r.value}</span>
						<span className="tabular-nums">{fmt(r.count)}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

/** What the drafted change would affect, the deciding rule elsewhere, and this client's timeline. */
export function ContextPanel({
	context,
	loading,
	error,
	question,
	ruleName,
	rayId,
	windowLabel,
}: {
	context: RequestContext | null;
	loading: boolean;
	error: string | null;
	question: "false-positive" | "false-negative";
	ruleName?: string;
	rayId: string;
	windowLabel: string;
}) {
	if (loading) return <section className={`${CARD} text-sm ${MUTED}`}>Reading what else this rule and this client did…</section>;
	if (error) return <section className={`${CARD} text-sm text-amber-700 dark:text-amber-400`}>The surrounding traffic could not be read: {error}</section>;
	if (!context) return null;
	const { impact, rule, timeline } = context;
	const clients = impact ? `${fmt(impact.distinctClients)}${impact.distinctCapped ? "+" : ""}` : "";
	return (
		<>
			{impact && (
				<section className={CARD}>
					<h2 className={`mb-1 ${SECTION_TITLE}`}>{question === "false-positive" ? "What the exception would let through" : "What the block rule would catch"}</h2>
					<p className={`mb-2 text-xs ${MUTED}`}>
						Requests in the {windowLabel} matching{" "}
						<code>
							{[impact.filter.host && `host ${impact.filter.host}`, impact.filter.path && `path ${impact.filter.path}`, impact.filter.clientIP && `IP ${impact.filter.clientIP}`]
								.filter(Boolean)
								.join(", ")}
						</code>
						. Cloudflare's sample-adjusted counts.
					</p>
					<div className="text-sm">
						<strong>{fmt(impact.requests)}</strong> requests from <strong>{clients}</strong> {impact.distinctClients === 1 ? "client" : "clients"}
						{question === "false-positive" && impact.ruleEvents !== undefined && (
							<>
								{" "}— <strong>{fmt(impact.ruleEvents)}</strong> of them were stopped by {ruleName ? `"${ruleName}"` : "the deciding rule"} and would be let through
							</>
						)}
						.
					</div>
					<div className="mt-2">
						<Breakdown counts={impact.byAction} />
					</div>
				</section>
			)}

			{rule && (
				<section className={CARD}>
					<h2 className={`mb-1 ${SECTION_TITLE}`}>{ruleName ? `"${ruleName}"` : "This rule"} across the zone</h2>
					<p className={`mb-2 text-xs ${MUTED}`}>Every time it acted in the {windowLabel} — a one-off, or a pattern?</p>
					<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
						<span>
							<strong>{fmt(rule.total)}</strong> events
						</span>
						<span>
							<strong>{fmt(rule.sameClient)}</strong> from this client
						</span>
						<span>
							<strong>{fmt(rule.samePath)}</strong> on this path
						</span>
						<Breakdown counts={rule.byAction} />
					</div>
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<TopList title="Hosts" rows={rule.topHosts} />
						<TopList title="Paths" rows={rule.topPaths} />
						<TopList title="Countries" rows={rule.topCountries} />
						<TopList title="Networks" rows={rule.topNetworks} />
					</div>
				</section>
			)}

			{timeline && (
				<section className={CARD}>
					<h2 className={`mb-1 ${SECTION_TITLE}`}>This client, an hour either side</h2>
					<p className={`mb-2 text-xs ${MUTED}`}>
						Request rows are sampled, so this is a picture of what the client did, not every request. Up to 100 shown.
					</p>
					{timeline.rows.length === 0 ? (
						<p className={`text-sm ${MUTED}`}>No other requests from this client in the sample.</p>
					) : (
						<div className="max-h-80 overflow-auto">
							<table className="w-full min-w-[640px] text-xs">
								<thead className={`sticky top-0 bg-white text-left dark:bg-zinc-900 ${MUTED}`}>
									<tr>
										{["Time", "Method", "Host", "Path", "Status", "Action"].map((h) => (
											<th key={h} className="px-2 py-1 font-medium">{h}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{timeline.rows.map((row, i) => {
										const self = String(row.rayName ?? "") === rayId;
										const action = String(row.securityAction ?? "");
										return (
											<tr key={i} className={`border-t border-zinc-100 dark:border-zinc-800/60 ${self ? "bg-sky-500/10 font-semibold" : ""}`}>
												<td className="whitespace-nowrap px-2 py-1">{new Date(String(row.datetime)).toLocaleTimeString()}</td>
												<td className="px-2 py-1">{String(row.clientRequestHTTPMethodName ?? "")}</td>
												<td className="max-w-[10rem] truncate px-2 py-1">{String(row.clientRequestHTTPHost ?? "")}</td>
												<td className="max-w-[16rem] truncate px-2 py-1 font-mono" title={String(row.clientRequestPath ?? "")}>
													{String(row.clientRequestPath ?? "")}
												</td>
												<td className="px-2 py-1">{String(row.edgeResponseStatus ?? "")}</td>
												<td className={`px-2 py-1 ${isBlocking(action) ? "text-red-600 dark:text-red-400" : ""}`}>
													{actionLabel(action)}
													{self && <span className={`ml-1 ${BADGE}`}>this request</span>}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</section>
			)}

			{context.errors.length > 0 && (
				<p className="text-xs text-amber-700 dark:text-amber-400">
					Not shown: {context.errors.map((e) => `${e.part} (${e.message})`).join("; ")}.
				</p>
			)}
		</>
	);
}

import { BADGE, CARD, MUTED, SECTION_TITLE, BADGE_NEUTRAL } from "../../lib/ui";
import { titleCase } from "../../lib/waf/format";
import { isBlocking, type ItemState, type RayHit, type RayVerdict } from "../../lib/waf/ray-verdict";
import type { RayReview } from "../../lib/waf/ray-review";
import type { RequestTraceResult } from "./types";

/**
 * The rule-level half of the Request Trace page: the verdict, the false-positive / false-negative
 * review, and every rule in the order Cloudflare evaluated them.
 */

/** Firewall event `source` values, in words. Unknown ones are shown as Cloudflare names them. */
const SOURCE_LABEL: Record<string, string> = {
	firewallCustom: "WAF custom rule",
	firewallManaged: "WAF managed rule",
	firewallRules: "Firewall rule (legacy)",
	ratelimit: "Rate limiting rule",
	linkMaze: "AI Labyrinth",
	securityLevel: "Security level",
	ipAccessRules: "IP access rule",
	uaBlock: "User agent blocking",
	zoneLockdown: "Zone lockdown",
	bic: "Browser integrity check",
	hot: "Hotlink protection",
	botFight: "Bot Fight Mode",
	botManagement: "Bot management",
	l7ddos: "HTTP DDoS protection",
	validation: "API Shield validation",
	apiShield: "API Shield",
	dlp: "Data loss prevention",
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

const STATE_STYLE: Record<ItemState, string> = {
	decided: "border-red-500/70 bg-red-500/10",
	matched: "border-sky-500/60 bg-sky-500/10",
	"no-match": "border-transparent",
	"not-reached": "border-transparent opacity-40",
};

function StateBadge({ state, hit }: { state: ItemState; hit?: RayHit }) {
	if (state === "decided") return <span className={`${BADGE} bg-red-500/15 text-red-600 dark:text-red-400`}>{titleCase(hit?.action || "")} — evaluation stopped here</span>;
	if (state === "matched") return <span className={`${BADGE} bg-sky-500/15 text-sky-700 dark:text-sky-300`}>Matched · {titleCase(hit?.action || "")}</span>;
	if (state === "not-reached") return <span className={`text-xs ${MUTED}`}>not reached</span>;
	return null;
}

export function Verdict({ verdict, trace }: { verdict: RayVerdict; trace: RequestTraceResult }) {
	const req = trace.request ?? {};
	const status = req.edgeResponseStatus;
	const { decidedBy } = verdict;
	// Only an outcome that stopped the request is a verdict (see isBlocking).
	const outcome = verdict.outcome && isBlocking(verdict.outcome.action) ? verdict.outcome : null;
	const logged = verdict.hits.filter((h) => !h.terminating).length;
	const outsideDecider = !decidedBy && outcome ? verdict.outside.find((h) => h.source === outcome.source) : undefined;
	let headline: string;
	let tone: string;
	if (decidedBy) {
		headline = `${titleCase(decidedBy.hit.action)} by "${decidedBy.item.row.name}"`;
		tone = "border-red-500/40 bg-red-500/5";
	} else if (outcome) {
		headline = `${titleCase(outcome.action)} by ${sourceLabel(outcome.source)}${outsideDecider ? ` — "${outsideDecider.description || outsideDecider.ruleId}"` : ""}`;
		tone = "border-red-500/40 bg-red-500/5";
	} else {
		headline = logged ? `Not blocked or challenged — ${logged} ${logged === 1 ? "rule" : "rules"} only logged or skipped it` : "No rule blocked or challenged this request";
		tone = "border-emerald-500/40 bg-emerald-500/5";
	}
	return (
		<section className={`rounded-xl border p-4 ${tone}`} aria-live="polite">
			<div className={`text-xs ${MUTED}`}>
				Ray <code className="font-mono">{trace.rayId}</code>
			</div>
			<div className="text-lg font-semibold">{headline}</div>
			<div className={`mt-1 text-sm ${MUTED}`}>
				{[req.clientRequestHTTPMethodName, `${str(req.clientRequestHTTPHost)}${str(req.clientRequestPath)}`, req.clientCountryName, status ? `HTTP ${status}` : ""]
					.filter(Boolean)
					.join(" · ")}
				{trace.foundIn ? ` · zone ${trace.foundIn.name}` : ""}
			</div>
			{decidedBy && (
				<div className="mt-2 text-sm">
					{decidedBy.stage.phaseLabel} · {decidedBy.stage.scope}
					{decidedBy.item.row.ruleset ? ` · ruleset "${decidedBy.item.row.ruleset}"` : ""} · rule #{decidedBy.item.position}
					{decidedBy.item.row.expression && (
						<code className="mt-2 block break-all rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-950">{decidedBy.item.row.expression}</code>
					)}
				</div>
			)}
			{!decidedBy && outcome && !outsideDecider && (
				<p className="mt-2 text-sm">
					Cloudflare reports the request's outcome, but none of the account's rulesets recorded the deciding match — the
					feature named above acted outside them.
				</p>
			)}
		</section>
	);
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function RulesTopDown({ verdict }: { verdict: RayVerdict }) {
	const phases: [string, RayVerdict["stages"]][] = [];
	for (const s of verdict.stages) {
		const last = phases[phases.length - 1];
		if (last && last[0] === s.stage.phaseLabel) last[1].push(s);
		else phases.push([s.stage.phaseLabel, [s]]);
	}
	return (
		<section className={CARD}>
			<h2 className={`mb-1 ${SECTION_TITLE}`}>Rules, in the order Cloudflare evaluated them</h2>
			<p className={`mb-3 text-xs ${MUTED}`}>
				Top to bottom: custom rules, rate limiting, managed rules; account before zone. Highlighted rules matched this request;
				red is where evaluation stopped. Rules with no highlight recorded no match. Rulesets that run hundreds of managed rules
				show only the ones that matched.
			</p>
			<div className="space-y-4">
				{phases.map(([label, stages], i) => (
					<div key={label}>
						<h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
							<span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 text-xs dark:bg-zinc-800">{i + 1}</span>
							{label}
						</h3>
						{stages.map(({ stage, items }) => (
							<div key={stage.entrypointId} className="mb-2 ml-7">
								<div className={`text-xs font-medium ${MUTED}`}>{stage.scope}</div>
								<ol className="mt-1 space-y-1">
									{items.map(({ item, state, hit, innerHits }) => (
										<li key={item.row.id} className={`rounded-md border px-2 py-1 text-sm ${STATE_STYLE[state]}`}>
											<div className="flex flex-wrap items-center gap-2">
												<span className={`w-7 shrink-0 text-right font-mono text-xs ${MUTED}`}>#{item.position}</span>
												<span className="min-w-0 flex-1">
													{item.target ? `Runs ${item.target.name}` : item.row.name}
													{item.target && <span className={`ml-1 text-xs ${MUTED}`}>({item.target.items.length} {item.target.items.length === 1 ? "rule" : "rules"})</span>}
												</span>
												{!item.row.enabled && <span className={BADGE_NEUTRAL}>Disabled</span>}
												{item.target ? (state === "not-reached" ? <StateBadge state={state} /> : null) : <StateBadge state={state} hit={hit} />}
											</div>
											{innerHits.length > 0 && (
												<ul className="mt-1 ml-9 space-y-1 border-l-2 border-zinc-200 pl-2 dark:border-zinc-800">
													{innerHits.map((h) => (
														<li key={h.item.row.id} className={`rounded border px-2 py-0.5 ${STATE_STYLE[h.state]}`}>
															<div className="flex flex-wrap items-center gap-2">
																<span className={`font-mono text-xs ${MUTED}`}>#{h.item.position}</span>
																<span className="min-w-0 flex-1">{h.item.row.name}</span>
																<StateBadge state={h.state} hit={h.hit} />
															</div>
														</li>
													))}
												</ul>
											)}
										</li>
									))}
								</ol>
							</div>
						))}
					</div>
				))}
			</div>
		</section>
	);
}


const POINT_STYLE: Record<RayReview["points"][number]["kind"], string> = {
	cause: "bg-red-500",
	signal: "bg-amber-500",
	note: "bg-zinc-400",
};

/** Was the verdict right? The case for a false positive (blocked) or a false negative (let through). */
export function ReviewPanel({ review }: { review: RayReview }) {
	return (
		<section className={CARD} aria-labelledby="ray-review-title">
			<h2 id="ray-review-title" className={`mb-1 ${SECTION_TITLE}`}>{review.title}</h2>
			<p className={`mb-3 text-xs ${MUTED}`}>
				{review.question === "false-positive"
					? "What stopped it, whether Cloudflare's own scores agree, and the smallest change that would let requests like it through."
					: "What let it pass, whether Cloudflare's own scores flagged it, and a rule that would have caught it."}
			</p>
			<ul className="space-y-1.5 text-sm">
				{review.points.map((p, i) => (
					<li key={i} className="flex gap-2">
						<span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${POINT_STYLE[p.kind]}`} />
						<span className="min-w-0 break-words">{p.text}</span>
					</li>
				))}
			</ul>
			{review.suggestions.length > 0 && (
				<div className="mt-4 space-y-3">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						{review.suggestions.length === 1 ? "Suggested change" : "Suggested changes"}
					</h3>
					{review.suggestions.map((s) => (
						<div key={s.title} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
							<div className="font-medium">{s.title}</div>
							<dl className="mt-1 grid grid-cols-[minmax(0,6rem)_1fr] gap-x-3 gap-y-1 text-xs">
								<dt className={MUTED}>Where</dt>
								<dd>{s.where}</dd>
								<dt className={MUTED}>Action</dt>
								<dd>{s.action}</dd>
								<dt className={MUTED}>Expression</dt>
								<dd>
									<code className="block select-all break-all rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-950">{s.expression}</code>
								</dd>
							</dl>
						</div>
					))}
					<p className={`text-xs ${MUTED}`}>
						Drafts from this one request — test them (the dashboard's expression preview, or Log first) before turning them on.
						Flarelens is read-only and changes nothing.
					</p>
				</div>
			)}
		</section>
	);
}

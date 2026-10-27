import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PageShell } from "../../components/PageShell";
import { EmptyState } from "../../components/EmptyState";
import { fetchWafRulesets, isSessionError, traceRequest } from "../../api/client";
import { getHashParams, setHashParam } from "../../hooks/useHashParams";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import { ALERT_ERROR, ALERT_WARN, BADGE, BADGE_NEUTRAL, BTN_PRIMARY, CARD, INPUT, MUTED, SECTION_TITLE } from "../../lib/ui";
import { titleCase } from "../../lib/waf/format";
import { buildRayVerdict, type ItemState, type RayHit, type RayVerdict } from "../../lib/waf/ray-verdict";
import type { RuleMetaMap } from "../../lib/waf/types";
import type { Session } from "../../hooks/useSession";
import type { CfZone } from "../../types";

const LOOKBACKS: [number, string][] = [
	[1440, "Last 24 hours"],
	[10080, "Last 7 days"],
	[43200, "Last 30 days"],
];

interface Trace {
	foundIn?: { id: string; name: string };
	request?: Record<string, unknown>;
	firewallEvents: Record<string, unknown>[];
	zonesSearched: { id: string; name: string }[];
	errors: { zone: string; message: string }[];
}

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
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

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

function Verdict({ verdict, trace }: { verdict: RayVerdict; trace: Trace }) {
	const req = trace.request ?? {};
	const status = req.edgeResponseStatus;
	const { decidedBy, outcome } = verdict;
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
		headline = "No rule blocked or challenged this request";
		tone = "border-emerald-500/40 bg-emerald-500/5";
	}
	return (
		<section className={`rounded-xl border p-4 ${tone}`} aria-live="polite">
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

function RulesTopDown({ verdict }: { verdict: RayVerdict }) {
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
													{item.target && <span className={`ml-1 text-xs ${MUTED}`}>({item.target.items.length} rules)</span>}
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

/** One Ray ID in; which rule blocked or challenged it, among all the rules in order, out. */
export function WhyBlockedPage({ session, zones, onAuthError }: { session: Session; zones: CfZone[]; onAuthError: () => void }) {
	const [rayInput, setRayInput] = useState(() => getHashParams().get("ray")?.trim() || "");
	const [zoneId, setZoneId] = useState("");
	const [minutes, setMinutes] = useState(10080);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [trace, setTrace] = useState<Trace | null>(null);
	const [verdict, setVerdict] = useState<RayVerdict | null>(null);
	const progress = useEstimatedProgress("cf_why_blocked_last_load_ms");
	const { start, stop } = progress;
	const requestId = useRef(0);

	const run = useCallback(
		async (ray: string) => {
			const id = ++requestId.current;
			setLoading(true);
			setError("");
			setTrace(null);
			setVerdict(null);
			setHashParam("ray", ray);
			start();
			let ok = false;
			try {
				const t = await traceRequest<Trace>(session.token, { accountId: session.accountId, rayId: ray, zoneId: zoneId || undefined, minutes });
				if (id !== requestId.current) return;
				setTrace(t);
				if (!t.foundIn) {
					setError("No request with this Ray ID was found in the window searched. Try a wider window, or check the Ray ID.");
					return;
				}
				// The zone's rules plus the account's, which run first. Edge-cached for 60s.
				const { result: meta } = await fetchWafRulesets<RuleMetaMap>(session.token, session.accountId, t.foundIn.id);
				if (id !== requestId.current) return;
				setVerdict(buildRayVerdict(t.firewallEvents, t.request, meta));
				ok = true;
			} catch (err) {
				if (id !== requestId.current) return;
				if (isSessionError(err)) {
					onAuthError();
					return;
				}
				setError(err instanceof Error ? err.message : "Could not look up this request");
			} finally {
				if (id === requestId.current) {
					setLoading(false);
					stop(ok);
				}
			}
		},
		[session.token, session.accountId, zoneId, minutes, onAuthError, start, stop],
	);

	// A deep link (#/why?ray=…) runs once on arrival.
	const deepLinked = useRef(getHashParams().get("ray")?.trim() || "");
	useEffect(() => {
		if (deepLinked.current) {
			const ray = deepLinked.current;
			deepLinked.current = "";
			void run(ray);
		}
	}, [run]);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (rayInput.trim()) void run(rayInput.trim());
	};

	return (
		<PageShell progress={progress}>
			<p className={`text-xs ${MUTED}`}>
				Paste the Ray ID from a Cloudflare block or challenge page (or a <code>cf-ray</code> response header) to see which rule
				acted, and where it sits among every rule that runs before and after it.
			</p>
			<form onSubmit={submit} className={`${CARD} flex flex-wrap items-end gap-3`}>
				<div className="min-w-[14rem] flex-1">
					<label htmlFor="why-ray" className="mb-1.5 block text-sm font-medium">Ray ID</label>
					<input id="why-ray" value={rayInput} onChange={(e) => setRayInput(e.target.value)} placeholder="a511938d1a0dd949-BKK" className={`w-full font-mono ${INPUT}`} />
				</div>
				<div>
					<label htmlFor="why-zone" className="mb-1.5 block text-sm font-medium">Zone</label>
					<select id="why-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} className={INPUT}>
						<option value="">All zones</option>
						{zones.map((z) => (
							<option key={z.id} value={z.id}>{z.name || z.id}</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor="why-window" className="mb-1.5 block text-sm font-medium">Window</label>
					<select id="why-window" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={INPUT}>
						{LOOKBACKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
					</select>
				</div>
				<button type="submit" disabled={loading || !rayInput.trim()} className={BTN_PRIMARY}>
					{loading ? "Looking up…" : "Explain"}
				</button>
			</form>

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}
			{trace && trace.errors.length > 0 && (
				<div role="status" className={ALERT_WARN}>
					Some zones could not be searched: {trace.errors.map((e) => `${e.zone} (${e.message})`).join("; ")}.
				</div>
			)}

			{verdict && trace ? (
				<>
					<Verdict verdict={verdict} trace={trace} />
					{verdict.hits.length > 0 && (
						<section className={CARD}>
							<h2 className={`mb-2 ${SECTION_TITLE}`}>Everything that acted on this request</h2>
							<ul className="space-y-1 text-sm">
								{verdict.hits.map((h, i) => (
									<li key={`${h.ruleId}-${i}`} className="flex flex-wrap items-center gap-2">
										<span className={`${BADGE} ${h.terminating ? "bg-red-500/15 text-red-600 dark:text-red-400" : BADGE_NEUTRAL}`}>{titleCase(h.action)}</span>
										<span>{h.description || h.ruleId || "—"}</span>
										<span className={`text-xs ${MUTED}`}>{sourceLabel(h.source)}</span>
									</li>
								))}
							</ul>
							{verdict.outside.length > 0 && (
								<p className={`mt-2 text-xs ${MUTED}`}>
									{verdict.outside.length === 1 ? "One of these comes" : `${verdict.outside.length} of these come`} from outside the WAF rulesets, so
									{verdict.outside.length === 1 ? " it isn't" : " they aren't"} placed in the order below.
								</p>
							)}
						</section>
					)}
					<RulesTopDown verdict={verdict} />
					<p className={`text-xs ${MUTED}`}>
						Full request detail for this Ray ID is in <a className="text-cf hover:underline" href={`#/request?ray=${encodeURIComponent(rayInput.trim())}`}>Request Trace</a>.
					</p>
				</>
			) : (
				!loading && !error && <EmptyState title="Enter a Ray ID to explain" />
			)}
		</PageShell>
	);
}

import { useMemo, useState } from "react";
import { PageShell } from "../../components/PageShell";
import { EmptyState } from "../../components/EmptyState";
import { ALERT_ERROR, BADGE, BADGE_NEUTRAL, CARD, INPUT, MUTED, SECTION_TITLE, SELECT } from "../../lib/ui";
import { buildEvalContext, evaluateAccess, type PolicyTrace, type RuleResult, type TestIdentity, type Tri, type Verdict } from "../../lib/access-eval";
import { describeRule, type RuleContext } from "../../lib/rules";
import type { LoadProgress } from "../../hooks/useEstimatedProgress";
import type { CfApp, CfGroup, CfIdp, CfList, CfPolicy } from "../../types";

interface PolicyTesterProps {
	apps: CfApp[];
	groups: CfGroup[];
	lists: CfList[];
	idps: CfIdp[];
	reusableMap: Record<string, CfPolicy>;
	ctx: RuleContext;
	loading: boolean;
	error: string | null;
	progress: LoadProgress;
}

const VERDICT: Record<Verdict, { label: string; tone: string; detail: string }> = {
	allowed: { label: "Allowed", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", detail: "An Allow policy matches." },
	service: { label: "Allowed (service token)", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", detail: "A Service Auth policy matches the token." },
	bypass: { label: "Bypassed", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400", detail: "A Bypass policy matches: the request reaches the app with no login at all." },
	blocked: { label: "Blocked", tone: "bg-red-500/10 text-red-600 dark:text-red-400", detail: "A Block policy matches before any Allow." },
	"denied-default": { label: "Denied", tone: "bg-red-500/10 text-red-600 dark:text-red-400", detail: "No policy matches, and Access denies by default." },
	"idp-not-allowed": { label: "Cannot log in", tone: "bg-red-500/10 text-red-600 dark:text-red-400", detail: "This application does not accept the chosen identity provider." },
	depends: { label: "Depends", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300", detail: "A policy that comes first cannot be decided from what was entered. See the policies marked ?" },
};

function Mark({ value }: { value: Tri }) {
	const [text, tone, label] =
		value === true
			? ["✓", "text-emerald-600 dark:text-emerald-400", "matches"]
			: value === false
				? ["✗", "text-zinc-500 dark:text-zinc-400", "does not match"]
				: ["?", "text-sky-600 dark:text-sky-300", "cannot tell"];
	return (
		<span className={`inline-block w-4 text-center font-semibold ${tone}`} aria-label={label} title={label}>
			{text}
		</span>
	);
}

function RuleList({ label, results, ctx }: { label: string; results: RuleResult[]; ctx: RuleContext }) {
	if (results.length === 0) return null;
	return (
		<div>
			<div className={`text-[11px] font-semibold uppercase tracking-wide ${MUTED}`}>{label}</div>
			<ul className="mt-0.5 space-y-0.5 text-sm">
				{results.map((r, i) => (
					<li key={i} className="flex gap-2">
						<Mark value={r.result} />
						<span>
							{describeRule(r.rule, ctx)}
							{r.note && <span className={`ml-1 text-xs ${MUTED}`}>— {r.note}</span>}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function decisionLabel(decision: string): string {
	return decision === "non_identity" ? "Service Auth" : decision === "deny" ? "Block" : decision ? decision[0].toUpperCase() + decision.slice(1) : "—";
}

function PolicyCard({ trace, deciding, ctx }: { trace: PolicyTrace; deciding: boolean; ctx: RuleContext }) {
	return (
		<li className={`rounded-lg border p-3 ${deciding ? "border-cf/60" : "border-zinc-200 dark:border-zinc-800"}`}>
			<div className="flex flex-wrap items-center gap-2">
				<Mark value={trace.match} />
				<span className="font-medium">{trace.policy.name || trace.policy.id}</span>
				<span className={`${BADGE} ${BADGE_NEUTRAL}`}>{decisionLabel(trace.decision)}</span>
				{trace.policy.reusable && <span className={`${BADGE} ${BADGE_NEUTRAL}`}>reusable</span>}
				{deciding && <span className={`${BADGE} bg-cf/15 text-cf`}>decides</span>}
			</div>
			<div className="mt-2 space-y-2 pl-6">
				<RuleList label="Include (any)" results={trace.include} ctx={ctx} />
				<RuleList label="Require (all)" results={trace.require} ctx={ctx} />
				<RuleList label="Exclude (none)" results={trace.exclude} ctx={ctx} />
			</div>
		</li>
	);
}

/**
 * "Would this person get into this application?" answered from the account's own policies,
 * without anyone logging in. The evaluation itself lives in lib/access-eval.ts.
 */
export function PolicyTesterPage({ apps, groups, lists, idps, reusableMap, ctx, loading, error, progress }: PolicyTesterProps) {
	const sortedApps = useMemo(() => [...apps].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)), [apps]);
	const [appId, setAppId] = useState("");
	const [mode, setMode] = useState<TestIdentity["mode"]>("user");
	const [email, setEmail] = useState("");
	const [idpId, setIdpId] = useState("");
	const [idpGroups, setIdpGroups] = useState("");
	const [country, setCountry] = useState("");
	const [ip, setIp] = useState("");
	const [serviceTokenId, setServiceTokenId] = useState("");

	const app = sortedApps.find((a) => a.id === appId) ?? null;
	const evalCtx = useMemo(() => buildEvalContext(groups, lists, idps, reusableMap), [groups, lists, idps, reusableMap]);

	const identity: TestIdentity = {
		mode,
		email: email.trim() || undefined,
		idpId: idpId || undefined,
		idpGroups: idpGroups.split(/[,\n]/).map((g) => g.trim()).filter(Boolean),
		country: country.trim() || undefined,
		ip: ip.trim() || undefined,
		serviceTokenId: serviceTokenId.trim() || undefined,
	};
	const result = app ? evaluateAccess(app, identity, evalCtx) : null;
	const allowedIdps = app?.allowed_idps?.length ? idps.filter((i) => app.allowed_idps?.includes(i.id)) : idps;

	return (
		<PageShell progress={progress}>
			<p className={`text-xs ${MUTED}`}>
				Check who an application lets in without anyone logging in. Policies are evaluated the way Access does: Bypass and
				Service Auth first, then Allow and Block top to bottom, first match wins, deny when nothing matches. Anything this page
				cannot know — groups you did not enter, device posture, a list too long to read in full — is marked ? rather than guessed.
			</p>

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Request</h2>
				<div className="grid gap-3 md:grid-cols-2">
					<label className="flex flex-col gap-1 text-sm md:col-span-2">
						Application
						<select value={appId} onChange={(e) => setAppId(e.target.value)} className={SELECT} disabled={loading && !apps.length}>
							<option value="">Choose an application…</option>
							{sortedApps.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name || a.id}
									{a.domain ? ` — ${a.domain}` : ""}
								</option>
							))}
						</select>
					</label>
					<fieldset className="flex items-center gap-4 text-sm md:col-span-2">
						<legend className="sr-only">Who is asking</legend>
						<label className="flex items-center gap-1.5">
							<input type="radio" name="tester-mode" checked={mode === "user"} onChange={() => setMode("user")} />
							A person logging in
						</label>
						<label className="flex items-center gap-1.5">
							<input type="radio" name="tester-mode" checked={mode === "service"} onChange={() => setMode("service")} />
							A service token
						</label>
					</fieldset>
					{mode === "user" ? (
						<>
							<label className="flex flex-col gap-1 text-sm">
								Email
								<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} placeholder="name@example.com" />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								Identity provider
								<select value={idpId} onChange={(e) => setIdpId(e.target.value)} className={SELECT}>
									<option value="">Not specified</option>
									{allowedIdps.map((i) => (
										<option key={i.id} value={i.id}>
											{i.name || i.id}
										</option>
									))}
								</select>
							</label>
							<label className="flex flex-col gap-1 text-sm md:col-span-2">
								Identity-provider groups <span className={`text-xs ${MUTED}`}>Entra ID / Okta / Google / GitHub group ids or names, comma-separated</span>
								<input value={idpGroups} onChange={(e) => setIdpGroups(e.target.value)} className={INPUT} />
							</label>
						</>
					) : (
						<label className="flex flex-col gap-1 text-sm md:col-span-2">
							Service token id
							<input value={serviceTokenId} onChange={(e) => setServiceTokenId(e.target.value)} className={INPUT} placeholder="token id" />
						</label>
					)}
					<label className="flex flex-col gap-1 text-sm">
						Country <span className={`text-xs ${MUTED}`}>two-letter code</span>
						<input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} className={INPUT} placeholder="TH" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						Source IP
						<input value={ip} onChange={(e) => setIp(e.target.value)} className={INPUT} placeholder="203.0.113.10" />
					</label>
				</div>
			</section>

			{!app ? (
				<EmptyState title={loading && !apps.length ? "Loading applications…" : "Choose an application to test"} />
			) : result ? (
				<section className={CARD} aria-live="polite">
					<div className="mb-3 flex flex-wrap items-center gap-3">
						<span className={`${BADGE} px-3 py-1 text-sm ${VERDICT[result.verdict].tone}`}>{VERDICT[result.verdict].label}</span>
						<span className="text-sm">{VERDICT[result.verdict].detail}</span>
					</div>
					{app.policies_error && (
						<p className={`mb-3 text-xs ${MUTED}`}>This application's policies could not be read, so the answer above may be incomplete.</p>
					)}
					{result.trace.length === 0 ? (
						<p className={`text-sm ${MUTED}`}>This application has no policies — Access denies everyone.</p>
					) : (
						<ol className="space-y-2">
							{[...result.trace.filter((t) => t.decision === "bypass" || t.decision === "non_identity"), ...result.trace.filter((t) => t.decision !== "bypass" && t.decision !== "non_identity")].map((t) => (
								<PolicyCard key={t.policy.id} trace={t} deciding={result.decidedBy === t} ctx={ctx} />
							))}
						</ol>
					)}
				</section>
			) : null}
		</PageShell>
	);
}

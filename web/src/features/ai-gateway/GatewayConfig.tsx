import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchAiGatewayConfig, fetchAiGatewayFlags, fetchAiGatewayRefusals, isSessionError } from "../../api/client";
import { MUTED } from "../../lib/ui";
import type { CoverageGap } from "./insights";
import { compactCount, shortModel, type AiGatewayConfigResult, type AiGatewayFilter, type AiGatewayFlagsResult, type AiGatewayRefusal, type AiGatewayRefusalGroup, type AiGatewayRefusalsResult, type AiGatewayRoute, type AiGatewayRouteStep, type AiGatewaySettings, type GuardrailSide } from "./types";

/**
 * What the AI Gateway REST API adds to the analytics (needs AI Gateway: Read): each gateway's
 * settings, its dynamic routes, and why the window's failed requests failed. Both reads are
 * best-effort beside the page's own load: a missing permission is said in place, never an error page.
 */

interface Extras {
	config: AiGatewayConfigResult | null;
	refusals: AiGatewayRefusalsResult | null;
	flags: AiGatewayFlagsResult | null;
	/** A read that failed outright (network, server), as opposed to one that said what it lacks. */
	error: string | null;
}

export function useAiGatewayExtras(token: string, accountId: string, from: string, to: string, windowKey: string, filter: AiGatewayFilter, filterKey: string, onAuthError: () => void): Extras {
	const [state, setState] = useState<Extras>({ config: null, refusals: null, flags: null, error: null });
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	// Settings change rarely: read once per account (and on Sync, which changes windowKey too).
	useEffect(() => {
		let live = true;
		fetchAiGatewayConfig<AiGatewayConfigResult>(token, { accountId })
			.then((config) => live && setState((s) => ({ ...s, config })))
			.catch((err) => {
				if (!live) return;
				if (isSessionError(err)) {
					onAuthErrorRef.current();
					return;
				}
				setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Failed to read AI Gateway settings" }));
			});
		return () => {
			live = false;
		};
	}, [token, accountId, windowKey]);
	// The logs follow the page: its window and the slice drilled into.
	useEffect(() => {
		let live = true;
		const body = { accountId, from, to, filter };
		const failed = (what: string) => (err: unknown) => {
			if (!live) return;
			if (isSessionError(err)) {
				onAuthErrorRef.current();
				return;
			}
			setState((s) => ({ ...s, error: err instanceof Error ? err.message : what }));
		};
		fetchAiGatewayRefusals<AiGatewayRefusalsResult>(token, body)
			.then((refusals) => live && setState((s) => ({ ...s, refusals })))
			.catch(failed("Failed to read AI Gateway logs"));
		fetchAiGatewayFlags<AiGatewayFlagsResult>(token, body)
			.then((flags) => live && setState((s) => ({ ...s, flags })))
			.catch(failed("Failed to read AI Gateway logs"));
		return () => {
			live = false;
		};
		// from/to move with the clock and the filter with its key; windowKey and filterKey stand for them.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, accountId, windowKey, filterKey]);
	return state;
}

const categoryChip = (code: string, names: Record<string, string>) => (
	<abbr key={code} title={names[code] ?? code} className="cursor-help no-underline">
		{code}
	</abbr>
);

function GuardrailCell({ side, label, names }: { side: GuardrailSide; label: string; names: Record<string, string> }) {
	if (!side.block.length && !side.flag.length) return null;
	return (
		<div>
			<span className={MUTED}>{label}: </span>
			{side.block.length > 0 && (
				<span className="text-red-700 dark:text-red-400">
					blocks{" "}
					{side.block.map((code, i) => (
						<span key={code}>
							{i ? ", " : ""}
							{categoryChip(code, names)}
						</span>
					))}
				</span>
			)}
			{side.block.length > 0 && side.flag.length > 0 && <span className={MUTED}> · </span>}
			{side.flag.length > 0 && <span className={MUTED} title={side.flag.map((c) => `${c} ${names[c] ?? ""}`).join("\n")}>flags {side.flag.length}</span>}
		</div>
	);
}

const seconds = (s: number) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** A route as a nested list read from its start: what it checks, where each outcome goes. */
function RouteTree({ route, mask }: { route: AiGatewayRoute; mask: (text: string) => string }) {
	const byId = new Map(route.steps.map((s) => [s.id, s]));
	const start = route.steps.find((s) => s.type === "start");
	const walk = (id: string | undefined, seen: Set<string>): ReactNode => {
		const step = id ? byId.get(id) : undefined;
		if (!step || seen.has(step.id) || step.type === "end") return null;
		const here = new Set(seen).add(step.id);
		if (step.type === "start") return walk(step.next.next, here);
		const branch = (label: string, to: string | undefined) => {
			const inner = walk(to, here);
			return inner ? (
				<li>
					<span className={MUTED}>{label} </span>
					<ul className="ml-4 list-none">{inner}</ul>
				</li>
			) : null;
		};
		if (step.type === "conditional") {
			return (
				<>
					{branch(step.condition ? `If ${mask(step.condition)}:` : "If (no condition set):", step.next.true)}
					{branch("Otherwise:", step.next.false)}
				</>
			);
		}
		if (step.limit) {
			const what = step.limit.kind === "cost" ? `$${step.limit.limit} of spend` : `${step.limit.limit} ${step.limit.kind}`;
			return (
				<>
					{branch(`Within ${what} per ${step.limit.key || "caller"} per ${seconds(step.limit.windowSeconds)}:`, step.next.success)}
					{branch("Over it:", step.next.fallback)}
				</>
			);
		}
		if (step.type === "model") return <ModelStep step={step} walk={(to) => walk(to, here)} />;
		return <li className={MUTED}>{step.type}</li>;
	};
	return <ul className="list-none text-xs">{walk(start?.id ?? route.steps[0]?.id, new Set())}</ul>;
}

function ModelStep({ step, walk }: { step: AiGatewayRouteStep; walk: (to: string | undefined) => ReactNode }) {
	const fallback = step.next.fallback && step.next.fallback !== step.next.success ? walk(step.next.fallback) : null;
	return (
		<li>
			→ <span className="font-medium" title={step.model}>{shortModel(step.model ?? "?")}</span>
			{step.provider && <span className={MUTED}> ({step.provider})</span>}
			{fallback && (
				<ul className="ml-4 list-none">
					<li>
						<span className={MUTED}>If it fails: </span>
						<ul className="ml-4 list-none">{fallback}</ul>
					</li>
				</ul>
			)}
		</li>
	);
}

/** Email-shaped text in a route condition, for while names are hidden. */
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

export function GatewaySettingsPanel({ config, focus, hideNames, gaps = [] }: { config: AiGatewayConfigResult; focus?: string; hideNames: boolean; gaps?: CoverageGap[] }) {
	const names = config.categoryNames;
	const mask = (text: string) => (hideNames ? text.replace(EMAIL, "…") : text);
	// The gateway drilled into, if any, first.
	const gateways = [...config.gateways].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
	const routesOf = (g: AiGatewaySettings) => config.routes.filter((r) => r.gateway === g.id);
	return (
		<div className="overflow-x-auto">
			{gaps.length > 0 && (
				<section aria-label="Coverage gaps" className="mb-3 text-xs">
					<h4 className="mb-1 font-semibold">Coverage gaps <span className={`font-normal ${MUTED}`}>· gateways carrying traffic in this window</span></h4>
					<ul className="space-y-0.5">
						{gaps.map((g) => (
							<li key={g.gateway}>
								<span className="font-medium">{g.gateway}</span> <span className={`tabular-nums ${MUTED}`}>({compactCount(g.requests)} requests)</span>: {g.gaps.join(", ")}
							</li>
						))}
					</ul>
				</section>
			)}
			<table className="w-full text-left text-xs" aria-label="Gateway settings">
				<thead className={MUTED}>
					<tr>
						{["Gateway", "Guardrails", "DLP", "Cache", "Rate limit", "Logs", "Spend limit"].map((h) => (
							<th key={h} scope="col" className="py-1.5 pr-3 font-medium">{h}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{gateways.map((g) => (
						<tr key={g.id} className={`border-t border-zinc-100 align-top dark:border-zinc-800 ${g.id === focus ? "bg-zinc-50 dark:bg-zinc-950/40" : ""}`}>
							<td className="py-1.5 pr-3 font-medium">
								{g.id}
								{g.isDefault && <span className={`ml-1 ${MUTED}`}>(default)</span>}
								{routesOf(g).map((r) => (
									<details key={r.name} className="mt-1 font-normal">
										<summary className="cursor-pointer text-cf">Route {r.name}</summary>
										<RouteTree route={r} mask={mask} />
									</details>
								))}
							</td>
							<td className="py-1.5 pr-3">
								{g.guardrails ? (
									<>
										<GuardrailCell side={g.guardrails.prompt} label="Prompt" names={names} />
										<GuardrailCell side={g.guardrails.response} label="Response" names={names} />
									</>
								) : (
									<span className={MUTED}>Off</span>
								)}
							</td>
							<td className="py-1.5 pr-3">
								{!g.dlp ? (
									<span className={MUTED}>Off</span>
								) : g.dlp.policies.length ? (
									g.dlp.policies.map((p) => (
										<div key={p.name} className={p.enabled ? "" : MUTED} title={`${p.profiles} profile${p.profiles === 1 ? "" : "s"}; checks ${p.check.join(" and ").toLowerCase() || "nothing"}`}>
											{p.name} <span className={p.action === "BLOCK" ? "text-red-700 dark:text-red-400" : MUTED}>({p.action.toLowerCase()})</span>
										</div>
									))
								) : (
									<span className={MUTED}>On, no policies</span>
								)}
							</td>
							<td className="py-1.5 pr-3 tabular-nums">{g.cacheTtl ? seconds(g.cacheTtl) : <span className={MUTED}>Off</span>}</td>
							<td className="py-1.5 pr-3 tabular-nums">
								{g.rateLimit ? `${g.rateLimit.limit} per ${seconds(g.rateLimit.intervalSeconds)}${g.rateLimit.technique ? ` (${g.rateLimit.technique})` : ""}` : <span className={MUTED}>Off</span>}
							</td>
							<td className="py-1.5 pr-3">{g.collectLogs ? `On${g.logLimit ? `, keeps ${compactCount(g.logLimit)}` : ""}` : <span className={MUTED}>Off</span>}</td>
							<td className="py-1.5 pr-3">{g.spendLimits ? "On" : <span className={MUTED}>Off</span>}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className={`mt-2 text-xs ${MUTED}`}>
				Category codes are the Guardrails hazard categories (S1–S14 from Llama Guard 3, P1 prompt injection); point at one for its name. A route lists where it can send a
				request; the logs record a routed request under the route's name, not the model that answered.
			</p>
		</div>
	);
}

const REASON_LABEL: Record<AiGatewayRefusal["reason"], string> = {
	guardrails: "Blocked by Guardrails",
	"guardrails-unlogged": "Blocked, category not logged",
	"guardrail-check": "Guardrail check failed",
	dlp: "Blocked by DLP",
	"rate-limited": "Rate limited",
	payment: "Payment refused",
	cancelled: "Cancelled by the client",
	error: "Failed",
	other: "Refused",
};

export function refusalDetail(g: Pick<AiGatewayRefusalGroup, "reason" | "detail" | "side">, names: Record<string, string>): string {
	if (g.reason === "guardrails") return `${g.detail} ${names[g.detail] ?? ""} · in the ${g.side}`.replace("  ", " ");
	if (g.reason === "guardrails-unlogged") return `HTTP ${g.detail}: through the Workers AI binding the log names no category`;
	if (g.reason === "guardrail-check") return `HTTP ${g.detail}: the guard model's own call failed`;
	if (g.reason === "payment") return g.detail === "402" ? "HTTP 402" : g.detail.replace(/_/g, " ");
	if (g.reason === "error") return `HTTP ${g.detail}`;
	return g.detail.replace(/_/g, " ");
}

/** One line for the diagram's pinned Blocked trace: the reasons behind the window's blocks. */
export function blockedSummary(refusals: AiGatewayRefusalsResult | null): string | undefined {
	if (!refusals || refusals.error) return undefined;
	const blocks = refusals.groups.filter((g) => g.reason === "guardrails" || g.reason === "guardrails-unlogged" || g.reason === "dlp");
	if (!blocks.length) return undefined;
	return blocks
		.map((g) => `${g.count} ${g.reason === "guardrails" ? `${refusals.categoryNames[g.detail] ?? g.detail} (${g.detail}, ${g.side})` : g.reason === "dlp" ? "DLP" : "category not logged"}`)
		.join(", ");
}

export function RefusalsPanel({ refusals, sliced = false }: { refusals: AiGatewayRefusalsResult; sliced?: boolean }) {
	const names = refusals.categoryNames;
	if (!refusals.total && !refusals.failed.length) return <p className={`text-xs ${MUTED}`}>No failed or refused requests in the AI Gateway logs for this {sliced ? "slice and window" : "window"}.</p>;
	return (
		<div className="space-y-3 text-xs">
			<table className="w-full text-left" aria-label="Refusals by reason">
				<thead className={MUTED}>
					<tr>
						<th scope="col" className="py-1.5 pr-3 font-medium">Why</th>
						<th scope="col" className="py-1.5 pr-3 font-medium">Detail</th>
						<th scope="col" className="py-1.5 pr-3 text-right font-medium">Requests</th>
						<th scope="col" className="py-1.5 pr-3 font-medium">Gateways</th>
					</tr>
				</thead>
				<tbody>
					{refusals.groups.map((g) => (
						<tr key={`${g.reason}-${g.detail}-${g.side}`} className="border-t border-zinc-100 dark:border-zinc-800">
							<td className={`py-1.5 pr-3 font-medium ${g.reason === "guardrails" || g.reason === "guardrails-unlogged" || g.reason === "dlp" ? "text-red-700 dark:text-red-400" : ""}`}>{REASON_LABEL[g.reason]}</td>
							<td className="py-1.5 pr-3">{refusalDetail(g, names)}</td>
							<td className="py-1.5 pr-3 text-right tabular-nums">{compactCount(g.count)}</td>
							<td className="py-1.5 pr-3">{g.gateways.join(", ")}</td>
						</tr>
					))}
				</tbody>
			</table>
			<details>
				<summary className="cursor-pointer text-cf">Latest {Math.min(refusals.recent.length, 50)}</summary>
				<div className="mt-1 max-h-72 overflow-auto">
					<table className="w-full text-left" aria-label="Latest refusals">
						<tbody>
							{refusals.recent.map((r, i) => (
								<tr key={`${r.at}-${i}`} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="py-1 pr-3 tabular-nums">{new Date(r.at).toLocaleString()}</td>
									<td className="py-1 pr-3">{r.gateway}</td>
									<td className="py-1 pr-3" title={r.model}>{shortModel(r.model)}</td>
									<td className="py-1 pr-3 tabular-nums">{r.status}</td>
									<td className="py-1 pr-3">
										{REASON_LABEL[r.reason]}
										{r.categories.length > 0 && <span className={MUTED}> · {r.categories.map((c) => `${c.code} ${names[c.code] ?? ""}`.trim()).join(", ")}</span>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
			<p className={MUTED}>
				From the AI Gateway logs: {compactCount(refusals.read)} of {compactCount(refusals.total)} failed requests in this window read (up to 200 a gateway), {sliced ? "for the slice drilled into" : "across all gateways"}. Only
				each log's time, gateway, model, status and verdicts are read — never its prompt, answer or metadata.
				{refusals.failed.length > 0 && ` Not readable: ${refusals.failed.map((f) => `${f.gateway} (${f.error})`).join(", ")}.`}
			</p>
		</div>
	);
}

const DLP_POLICY_NOTE = "the policy's name, as set on the gateway";

export function FlagsPanel({ flags, sliced = false }: { flags: AiGatewayFlagsResult; sliced?: boolean }) {
	const names = flags.categoryNames;
	const onGuard = flags.groups.reduce((n, g) => n + g.onGuardModel, 0);
	return (
		<div className="space-y-2 text-xs">
			{flags.groups.length ? (
				<table className="w-full text-left" aria-label="Flags by verdict">
					<thead className={MUTED}>
						<tr>
							<th scope="col" className="py-1.5 pr-3 font-medium">Flagged by</th>
							<th scope="col" className="py-1.5 pr-3 font-medium">For</th>
							<th scope="col" className="py-1.5 pr-3 font-medium">In the</th>
							<th scope="col" className="py-1.5 pr-3 text-right font-medium">Times</th>
							<th scope="col" className="py-1.5 pr-3 font-medium">Gateways</th>
						</tr>
					</thead>
					<tbody>
						{flags.groups.map((g) => (
							<tr key={`${g.kind}-${g.detail}-${g.side}`} className="border-t border-zinc-100 dark:border-zinc-800">
								<td className="py-1.5 pr-3 font-medium">{g.kind === "dlp" ? "DLP" : "Guardrails"}</td>
								<td className="py-1.5 pr-3" title={g.kind === "dlp" ? DLP_POLICY_NOTE : undefined}>
									{g.kind === "dlp" ? g.detail : `${g.detail} ${names[g.detail] ?? ""}`.trim()}
								</td>
								<td className="py-1.5 pr-3">{g.side ?? "—"}</td>
								<td className="py-1.5 pr-3 text-right tabular-nums">
									{compactCount(g.count)}
									{g.onGuardModel > 0 && <span className={MUTED}> ({compactCount(g.onGuardModel)} on the guard model)</span>}
								</td>
								<td className="py-1.5 pr-3">{g.gateways.join(", ")}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className={MUTED}>Nothing flagged in the logs read.</p>
			)}
			<p className={MUTED}>
				These passed: setting a flag to block would have refused them. Read {compactCount(flags.scanned)} of {compactCount(flags.total)} successful requests in this window (the latest, up to 250 a gateway, on gateways with Guardrails or
				DLP{sliced ? ", for the slice drilled into" : ""}), so {flags.scanned < flags.total ? "these are a floor, not a total" : "this is all of them"}.
				{onGuard > 0 && " AI Gateway logs its calls to the guard model as requests of their own, which can carry the same prompt, so those counts can overlap a request's."}
				{flags.skipped.length > 0 && ` Not scanned: ${flags.skipped.join(", ")}.`}
				{flags.failed.length > 0 && ` Not readable: ${flags.failed.map((f) => `${f.gateway} (${f.error})`).join(", ")}.`} Never a prompt, answer or metadata.
			</p>
		</div>
	);
}

/** The line a pinned `dynamic/…` model shows: where that route can send a request. */
export function routeNote(routes: AiGatewayRoute[] | undefined, model: string): string | undefined {
	const matches = (routes ?? []).filter((r) => r.model === model);
	if (!matches.length) return undefined;
	return matches
		.map((r) => `Route ${r.name} on ${r.gateway} can send to ${r.models.map(shortModel).join(", ") || "no model"}`)
		.concat("analytics records the route, not the model that answered")
		.join("; ");
}

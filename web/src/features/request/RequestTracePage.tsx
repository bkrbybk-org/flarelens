import { useState, type FormEvent } from "react";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, CARD, SECTION_TITLE } from "../../lib/ui";
import { ProgressBar } from "../../components/ProgressBar";
import { SearchIcon } from "../../components/Icons";
import type { Session } from "../../hooks/useSession";
import type { CfZone } from "../../types";
import { useRequestTrace } from "./useRequestTrace";
import {
	FIELD_GROUPS,
	METADATA_ENCRYPTED_BODY,
	METADATA_MATCHED_VARS,
	formatValue,
	metadataValue,
	valueTone,
} from "./types";
import { DecryptKeyPanel, PromptPayload } from "../ai-security/PromptPayload";


const LOOKBACKS: [number, string][] = [
	[1440, "Last 24 hours"],
	[10_080, "Last 7 days"],
	[43_200, "Last 30 days"],
];

export function RequestTracePage({
	session,
	zones,
	onAuthError,
}: {
	session: Session;
	zones: CfZone[];
	onAuthError: () => void;
}) {
	const [rayInput, setRayInput] = useState("");
	const [zoneId, setZoneId] = useState("");
	const [minutes, setMinutes] = useState(1440);
	/**
	 * Payload-decryption key, in component state only — never stored, never sent to the Worker.
	 * Same rule as the AI Security events table, and the same components enforce it.
	 */
	const [privateKey, setPrivateKey] = useState("");
	const { result, loading, error, progress, load } = useRequestTrace(onAuthError);

	function submit(event: FormEvent) {
		event.preventDefault();
		const ray = rayInput.trim();
		if (ray) load(session.token, session.accountId, ray, zoneId, minutes);
	}

	const request = result?.request;
	const shown = new Set<string>();

	return (
		<PageShell>
			<form onSubmit={submit} className={`${CARD}`}>
				<div className="flex flex-wrap items-end gap-3">
					<div className="min-w-0 flex-1 basis-72">
						<label htmlFor="ray-id" className="mb-1.5 block text-sm font-medium">Ray ID</label>
						<div className="relative">
							<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
							<input
								id="ray-id"
								value={rayInput}
								onChange={(e) => setRayInput(e.target.value)}
								placeholder="a3633412999ba62b"
								spellCheck={false}
								className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 font-mono text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</div>
					</div>
					<div>
						<label htmlFor="ray-zone" className="mb-1.5 block text-sm font-medium">Zone</label>
						<select
							id="ray-zone"
							value={zoneId}
							onChange={(e) => setZoneId(e.target.value)}
							className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="">All zones</option>
							{zones.map((zone) => (
								<option key={zone.id} value={zone.id}>{zone.name}</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor="ray-window" className="mb-1.5 block text-sm font-medium">Window</label>
						<select
							id="ray-window"
							value={minutes}
							onChange={(e) => setMinutes(Number(e.target.value))}
							className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
						>
							{LOOKBACKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
						</select>
					</div>
					<button
						type="submit"
						disabled={loading || !rayInput.trim()}
						className="rounded-lg bg-cf px-4 py-2 text-sm font-semibold text-white transition hover:bg-cf-hover disabled:opacity-60"
					>
						{loading ? "Searching…" : "Trace"}
					</button>
				</div>
				<p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
					The Ray ID from a response header or the browser's network tab. A colo suffix such as
					<code className="mx-1 font-mono">-BKK</code> is ignored.
				</p>
			</form>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{result?.errors.map((e) => (
				<div key={e.zone} role="status" className={ALERT_WARN}>
					{e.zone}: {e.message}
				</div>
			))}

			{result && !result.foundIn && (
				// Sampling makes absence genuinely inconclusive, and saying "not found" flatly
				// would invite the wrong conclusion in exactly the situation someone is
				// investigating an incident.
				<div role="status" className={`${CARD} mb-4 border-amber-300/50 bg-amber-500/10 dark:border-amber-500/30`}>
					<h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">No matching request in this window</h2>
					<p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
						Searched {result.zonesSearched.length} zone{result.zonesSearched.length === 1 ? "" : "s"} from{" "}
						{new Date(result.window.since).toLocaleString()}. This does not prove the request never happened:
						Cloudflare samples <code className="font-mono">httpRequestsAdaptive</code> adaptively, so an individual
						request can be absent from the data while having been served normally. Widen the window, or confirm the
						Ray ID and zone.
					</p>
				</div>
			)}

			{result?.foundIn && (
				<>
					<div className={`${CARD} mb-4`}>
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h2 className={SECTION_TITLE}>
								Ray <code className="font-mono">{result.rayId}</code>
							</h2>
							<span className="text-xs text-zinc-500 dark:text-zinc-400">
								found in <strong>{result.foundIn.name}</strong>
							</span>
						</div>
					</div>

					<div className="mb-4 grid gap-4 lg:grid-cols-2">
						{FIELD_GROUPS.map((group) => {
							const rows = group.fields.filter(([key]) => {
								if (!request || !(key in request) || shown.has(key)) return false;
								shown.add(key);
								return true;
							});
							if (!rows.length) return null;
							return (
								<section key={group.title} className={CARD}>
									<h3 className={`mb-3 ${SECTION_TITLE}`}>{group.title}</h3>
									<dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1 text-sm">
										{rows.map(([key, label]) => (
											<div key={key} className="contents">
												<dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
												<dd className={`break-all font-mono text-xs ${valueTone(key, request?.[key])}`}>
													{formatValue(key, request?.[key])}
												</dd>
											</div>
										))}
									</dl>
								</section>
							);
						})}
					</div>

					{(() => {
						const leftovers = Object.keys(request ?? {})
							.filter((key) => !shown.has(key) && key !== "rayName" && key !== "rayId")
							.filter((key) => {
								const value = request?.[key];
								return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length);
							})
							.sort();
						if (!leftovers.length) return null;
						return (
							<section className={`${CARD} mb-4`}>
								<h3 className={`mb-3 ${SECTION_TITLE}`}>Other fields ({leftovers.length})</h3>
								<p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
									Everything else this zone's schema returned for the request. Swept from the schema rather than
									listed in code, so a field Cloudflare adds later shows up here without a change.
								</p>
								<dl className="grid gap-x-3 gap-y-1 text-sm md:grid-cols-2">
									{leftovers.map((key) => (
										<div key={key} className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-3">
											<dt className="truncate text-zinc-500 dark:text-zinc-400" title={key}>{key}</dt>
											<dd className={`break-all font-mono text-xs ${valueTone(key, request?.[key])}`}>
												{formatValue(key, request?.[key])}
											</dd>
										</div>
									))}
								</dl>
							</section>
						);
					})()}

					{result.firewallEvents.some((event) => metadataValue(event, METADATA_ENCRYPTED_BODY)) && (
						<section className={`${CARD} mb-4`}>
							<h3 className={`mb-3 ${SECTION_TITLE}`}>Request body</h3>
							<p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
								A rule with payload logging captured this request's body. Cloudflare stores it encrypted to the
								zone's public key; decryption happens in this browser and the key is never sent anywhere.
							</p>
							<DecryptKeyPanel privateKey={privateKey} onChange={setPrivateKey} />
							{result.firewallEvents.map((event, index) => {
								const ciphertext = metadataValue(event, METADATA_ENCRYPTED_BODY);
								if (!ciphertext) return null;
								const matched = metadataValue(event, METADATA_MATCHED_VARS);
								return (
									<div key={index} className="mb-3 last:mb-0">
										{matched && (
											<div className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
												Matched fields: <span className="font-mono">{matched}</span>
											</div>
										)}
										<PromptPayload ciphertext={ciphertext} privateKey={privateKey} />
									</div>
								);
							})}
						</section>
					)}

					<section className={CARD}>
						<h3 className={`mb-3 ${SECTION_TITLE}`}>
							Firewall events {result.firewallEvents.length > 0 && `(${result.firewallEvents.length})`}
						</h3>
						{result.firewallEvents.length === 0 ? (
							<p className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
								No WAF or firewall rule recorded a match for this Ray ID.
							</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full min-w-[720px] text-sm">
									<thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
										<tr>
											{["Time", "Action", "Source", "Rule", "Host", "Path"].map((h) => (
												<th key={h} className="px-2 py-2 text-left font-medium">{h}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{result.firewallEvents.map((event, index) => (
											<tr key={index} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
												<td className="whitespace-nowrap px-2 py-2">{formatValue("datetime", event.datetime)}</td>
												<td className={`px-2 py-2 ${valueTone("securityAction", event.action)}`}>{formatValue("action", event.action)}</td>
												<td className="px-2 py-2">{formatValue("source", event.source)}</td>
												<td className="max-w-[18rem] truncate px-2 py-2" title={String(event.description ?? "")}>
													{formatValue("description", event.description ?? event.ruleId)}
												</td>
												<td className="px-2 py-2">{formatValue("host", event.clientRequestHTTPHost)}</td>
												<td className="max-w-[14rem] truncate px-2 py-2" title={String(event.clientRequestPath ?? "")}>
													{formatValue("path", event.clientRequestPath)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					{result.unavailableFields.length > 0 && (
						<p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
							Not exposed to this token or plan: {result.unavailableFields.join(", ")}.
						</p>
					)}
				</>
			)}
		</PageShell>
	);
}

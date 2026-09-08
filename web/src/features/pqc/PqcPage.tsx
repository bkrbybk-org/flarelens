import { useEffect, useMemo, useState } from "react";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon, SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { Session } from "../../hooks/useSession";
import { usePqcReport } from "./usePqcReport";
import type { CipherGrade, CipherSummary, InboundState, OriginState, PqcRow, PqcZoneSummary, Verdict } from "./types";

const CARD = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

const VERDICT_LABEL: Record<Verdict, string> = {
	ready: "Ready",
	eligible: "Eligible",
	"not-ready": "Not ready",
	unknown: "Unknown",
};

const VERDICT_TONE: Record<Verdict, string> = {
	ready: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	eligible: "bg-cf/15 text-cf",
	"not-ready": "bg-red-500/10 text-red-600 dark:text-red-400",
	unknown: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

const INBOUND_LABEL: Record<InboundState, string> = {
	pqc: "X25519MLKEM768 offered",
	"not-proxied": "DNS-only — not terminated by Cloudflare",
	"tls13-off": "TLS 1.3 off",
	unknown: "Unknown",
};

const ORIGIN_LABEL: Record<OriginState, string> = {
	tunnel: "Tunnel (post-quantum)",
	cloudflare: "Cloudflare-hosted (no origin leg)",
	eligible: "Automatic key exchange",
	plaintext: "Plain HTTP to origin",
	unknown: "Unknown",
};

/**
 * A leg's own state, muted or loud by whether it is the thing blocking the row.
 *
 * Both legs are always shown, including the passing one: an operator fixing a red row needs to
 * know which half to touch, and "not ready" alone does not say.
 */
function LegChip({ label, good, bad }: { label: string; good: boolean; bad: boolean }) {
	const tone = bad
		? "bg-red-500/10 text-red-600 dark:text-red-400"
		: good
			? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
			: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400";
	return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>;
}

const CIPHER_TONE: Record<CipherGrade, string> = {
	"aead-fs": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	tls13: "bg-cf/15 text-cf",
	"legacy-cbc": "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	"no-fs": "bg-red-500/10 text-red-600 dark:text-red-400",
	broken: "bg-red-600/20 text-red-700 dark:text-red-300",
};

const CIPHER_GRADE_LABEL: Record<CipherGrade, string> = {
	"aead-fs": "AEAD + forward secrecy",
	tls13: "TLS 1.3",
	"legacy-cbc": "CBC",
	"no-fs": "no forward secrecy",
	broken: "obsolete",
};

/** One zone's cipher posture. Collapsed unless there is something to answer for. */
function CipherPanel({ zone }: { zone: PqcZoneSummary }) {
	const c: CipherSummary = zone.ciphers;

	if (c.mode === "unreadable") {
		return <span className="text-xs text-amber-600 dark:text-amber-400">unreadable</span>;
	}
	if (c.mode === "default") {
		return (
			<span className="text-xs text-zinc-500 dark:text-zinc-400" title="No custom selection, so Cloudflare's default suites apply. Customising needs Advanced Certificate Manager.">
				Cloudflare default{c.supersededByTls13 ? " · TLS 1.3 only, so unused" : ""}
			</span>
		);
	}

	return (
		<details className="min-w-0">
			<summary className="cursor-pointer select-none text-xs">
				<span className="font-medium">{c.suites.length} custom</span>
				{(["broken", "no-fs", "legacy-cbc", "aead-fs"] as CipherGrade[])
					.filter((grade) => c.counts[grade])
					.map((grade) => (
						<span key={grade} className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${CIPHER_TONE[grade]}`}>
							{c.counts[grade]} {CIPHER_GRADE_LABEL[grade]}
						</span>
					))}
			</summary>
			{c.findings.length > 0 && (
				<ul className="mt-1.5 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-300">
					{c.findings.map((f) => (
						<li key={f}>{f}</li>
					))}
				</ul>
			)}
			<ul className="mt-1.5 flex flex-wrap gap-1">
				{c.suites.map((suite) => (
					<li key={suite.name}>
						<span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${CIPHER_TONE[suite.grade]}`} title={suite.note}>
							{suite.name}
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

function Kpi({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: string }) {
	return (
		<div className={CARD}>
			<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value.toLocaleString()}</div>
			<div className="mt-0.5 text-xs text-zinc-400">{hint}</div>
		</div>
	);
}

const FILTERS: { key: Verdict | "all"; label: string }[] = [
	{ key: "all", label: "All" },
	{ key: "not-ready", label: "Not ready" },
	{ key: "unknown", label: "Unknown" },
	{ key: "eligible", label: "Eligible" },
	{ key: "ready", label: "Ready" },
];

export function PqcPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<Verdict | "all">("all");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = usePqcReport(onAuthError);

	useEffect(() => {
		load(session.token, session.accountId);
	}, [session.token, session.accountId, reloadKey, load]);

	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		let all: PqcRow[] = result?.rows ?? [];
		if (filter !== "all") all = all.filter((row) => row.verdict === filter);
		if (q) all = all.filter((row) => `${row.fqdn} ${row.zoneName} ${row.type}`.toLowerCase().includes(q));
		return all;
	}, [result, search, filter]);

	const totals = result?.totals ?? { hostnames: 0, ready: 0, eligible: 0, notReady: 0, unknown: 0 };

	function exportCsv() {
		const csv = toCsv(rows, [
			{ header: "fqdn", value: (r) => r.fqdn },
			{ header: "zone", value: (r) => r.zoneName },
			{ header: "record_type", value: (r) => r.type },
			{ header: "proxied", value: (r) => (r.proxied ? "yes" : "no") },
			{ header: "visitor_to_cloudflare", value: (r) => INBOUND_LABEL[r.inbound] },
			{ header: "cloudflare_to_origin", value: (r) => ORIGIN_LABEL[r.origin] },
			{ header: "verdict", value: (r) => VERDICT_LABEL[r.verdict] },
			{ header: "reasons", value: (r) => r.reasons.join(" ") },
			{
				header: "zone_ciphers",
				value: (r) => {
					const zone = (result?.zones ?? []).find((z) => z.zoneId === r.zoneId);
					if (!zone || zone.ciphers.mode !== "custom") return zone?.ciphers.mode ?? "";
					return zone.ciphers.suites.map((s) => `${s.name} (${s.grade})`).join(" | ");
				},
			},
		]);
		downloadCsv(`pqc-readiness-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<div className="h-full overflow-auto p-4 md:p-6">
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-72">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search hostname or zone…"
						aria-label="Search hostnames"
						className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</div>
				<div className="flex flex-wrap gap-1">
					{FILTERS.map((f) => (
						<button
							key={f.key}
							type="button"
							onClick={() => setFilter(f.key)}
							className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
								filter === f.key
									? "border-cf bg-cf/10 text-cf"
									: "border-zinc-200 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
							}`}
						>
							{f.label}
						</button>
					))}
				</div>
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{rows.length.toLocaleString()} of {totals.hostnames.toLocaleString()}
				</span>
				<button
					type="button"
					onClick={exportCsv}
					disabled={!rows.length}
					className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					Export CSV
				</button>
				<button
					type="button"
					onClick={() => setReloadKey((k) => k + 1)}
					disabled={loading}
					className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					<RefreshIcon size={14} className={loading ? "animate-spin" : ""} />
					Refresh
				</button>
			</div>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className="mb-4 rounded-lg border border-red-300/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
					{error}
				</div>
			)}

			{result?.errors.map((e) => (
				<div key={e.source} role="status" className="mb-4 rounded-lg border border-amber-300/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
					{e.source}: {e.message}
				</div>
			))}

			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
				<Kpi label="Hostnames" value={totals.hostnames} hint="A, AAAA and CNAME records" />
				<Kpi label="Not ready" value={totals.notReady} hint="DNS-only, TLS 1.3 off, or plaintext origin" tone={totals.notReady ? "text-red-600 dark:text-red-400" : undefined} />
				<Kpi label="Unknown" value={totals.unknown} hint="a setting could not be read" tone={totals.unknown ? "text-amber-700 dark:text-amber-400" : undefined} />
				<Kpi label="Eligible" value={totals.eligible} hint="origin leg may negotiate PQC" />
				<Kpi label="Ready" value={totals.ready} hint="both legs post-quantum" tone={totals.ready ? "text-emerald-600 dark:text-emerald-400" : undefined} />
			</div>

			{/* The distinction the whole page turns on. Without it "Eligible" reads as a pass and
			    the report overstates coverage. */}
			<div className={`${CARD} mb-4 text-sm text-zinc-600 dark:text-zinc-300`}>
				<p>
					<strong>Ready</strong> means both legs are post-quantum: the visitor connection is offered X25519MLKEM768,
					and the origin is reached over a Cloudflare Tunnel or is Cloudflare itself.{" "}
					<strong>Eligible</strong> means only the origin leg is unconfirmed — automatic key exchange applies and
					Cloudflare prefers X25519MLKEM768 when the origin supports it, but Cloudflare does not publish that scan
					result per zone, so this dashboard will not claim it. Verify the origin directly:
				</p>
				<pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-zinc-800">
					bssl client -connect &lt;origin&gt;:443 -curves X25519MLKEM768
				</pre>
			</div>

			<section className={`${CARD} mb-4`}>
				<h2 className="mb-3 text-sm font-semibold">Zones</h2>
				{/* Cipher suites are a separate axis from key agreement, and conflating them would
				    misread the page: a zone can offer X25519MLKEM768 and still allow a suite with
				    no forward secrecy, which is the same harvest-now exposure by another route. */}
				<p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
					Cipher suites cover TLS 1.0–1.2 only — TLS 1.3 suites are fixed and not configurable — so they do not
					change any verdict above. They are the other half of the same exposure: a suite with no forward secrecy
					leaves recorded traffic readable to whoever later obtains the certificate key, with or without a quantum
					computer. Customising the list needs Advanced Certificate Manager; zones without it read “Cloudflare
					default”.
				</p>
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							<tr>
								<th className="py-1.5 pr-3 font-medium">Zone</th>
								<th className="py-1.5 pr-3 font-medium">TLS 1.3</th>
								<th className="py-1.5 pr-3 font-medium">Min TLS</th>
								<th className="py-1.5 pr-3 font-medium">SSL mode</th>
								<th className="py-1.5 pr-3 font-medium">Cipher suites (TLS 1.0–1.2)</th>
								<th className="py-1.5 pr-3 text-right font-medium">Hostnames</th>
								<th className="py-1.5 pr-3 text-right font-medium">Not ready</th>
							</tr>
						</thead>
						<tbody>
							{(result?.zones ?? []).map((zone) => (
								<tr key={zone.zoneId} className="border-t border-zinc-100 dark:border-zinc-800">
									<td className="py-1.5 pr-3 font-medium">{zone.zoneName}</td>
									<td className={`py-1.5 pr-3 ${zone.tls13 === "on" ? "" : "text-red-600 dark:text-red-400"}`}>
										{zone.tls13 ?? "unreadable"}
									</td>
									<td className="py-1.5 pr-3">{zone.minTlsVersion ?? "—"}</td>
									<td className={`py-1.5 pr-3 ${zone.sslMode === "off" || zone.sslMode === "flexible" ? "text-red-600 dark:text-red-400" : ""}`}>
										{zone.sslMode ?? "unreadable"}
										{zone.error && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">{zone.error}</span>}
									</td>
									<td className="py-1.5 pr-3 align-top">
										<CipherPanel zone={zone} />
									</td>
									<td className="py-1.5 pr-3 text-right tabular-nums">{zone.hostnames}</td>
									<td className={`py-1.5 pr-3 text-right tabular-nums ${zone.notReady ? "text-red-600 dark:text-red-400" : ""}`}>
										{zone.notReady}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section className={CARD}>
				<h2 className="mb-3 text-sm font-semibold">Hostnames</h2>
				{rows.length === 0 ? (
					<p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
						{loading ? "Loading…" : "Nothing to show for this filter."}
					</p>
				) : (
					<ul className="space-y-2">
						{rows.map((row) => (
							<li key={`${row.zoneId}|${row.fqdn}|${row.type}`} className="rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
								<div className="flex flex-wrap items-center gap-2">
									<span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_TONE[row.verdict]}`}>
										{VERDICT_LABEL[row.verdict]}
									</span>
									<span className="font-medium">{row.fqdn}</span>
									<span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{row.type}</span>
									<span className="text-xs text-zinc-500 dark:text-zinc-400">{row.zoneName}</span>
								</div>
								<div className="mt-1.5 flex flex-wrap items-center gap-2">
									<span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">Visitor → Cloudflare</span>
									<LegChip label={INBOUND_LABEL[row.inbound]} good={row.inbound === "pqc"} bad={row.inbound === "not-proxied" || row.inbound === "tls13-off"} />
									<span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">Cloudflare → origin</span>
									<LegChip label={ORIGIN_LABEL[row.origin]} good={row.origin === "tunnel" || row.origin === "cloudflare"} bad={row.origin === "plaintext"} />
								</div>
								<ul className="mt-1.5 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
									{row.reasons.map((reason) => (
										<li key={reason}>{reason}</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

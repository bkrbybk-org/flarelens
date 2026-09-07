import { useEffect, useMemo, useState } from "react";
import { ProgressBar } from "../../components/ProgressBar";
import { RefreshIcon, SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { Session } from "../../hooks/useSession";
import { useTunnelMap } from "./useTunnelMap";
import { chainText, statusTone, type MappingRow } from "./types";

const CARD = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

function DecisionChip({ decision }: { decision: string }) {
	const tone =
		decision === "allow"
			? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
			: decision === "deny"
				? "bg-red-500/10 text-red-600 dark:text-red-400"
				: decision === "bypass"
					? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
					: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400";
	return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{decision}</span>;
}

function GapBadge({ gap }: { gap: MappingRow["gap"] }) {
	if (!gap) return null;
	const isUngated = gap === "no-access-app";
	return (
		<span
			className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
				isUngated ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
			}`}
			title={
				isUngated
					? "This tunnel hostname has no Access application in front of it — the origin is reachable without an Access policy."
					: "This Access application's hostname is not served by any tunnel ingress rule. Its origin may be public or reached another way."
			}
		>
			{isUngated ? "No Access app" : "No tunnel"}
		</span>
	);
}

/** One hop of the chain. Kept flat so a row reads left to right like the path a request takes. */
function Hop({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0">
			<div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">{label}</div>
			<div className="truncate text-sm">{children}</div>
		</div>
	);
}

export function TunnelMapPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, progress, load } = useTunnelMap(onAuthError);

	useEffect(() => {
		load(session.token, session.accountId);
	}, [session.token, session.accountId, reloadKey, load]);

	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		const all = result?.rows ?? [];
		return q ? all.filter((row) => chainText(row).toLowerCase().includes(q)) : all;
	}, [result, search]);

	const ungated = (result?.rows ?? []).filter((r) => r.gap === "no-access-app").length;
	const mapped = (result?.rows ?? []).filter((r) => !r.gap).length;

	function exportCsv() {
		const csv = toCsv(rows, [
			{ header: "hostname", value: (r) => r.hostname },
			{ header: "path", value: (r) => r.path ?? "" },
			{ header: "access_app", value: (r) => r.app?.name ?? "" },
			{ header: "policies", value: (r) => (r.app ? r.app.policies.map((p) => `${p.name} (${p.decision})`).join(" | ") : "") },
			{ header: "tunnel", value: (r) => r.tunnel?.name ?? "" },
			{ header: "tunnel_status", value: (r) => r.tunnel?.status ?? "" },
			{ header: "origin", value: (r) => r.service },
			{ header: "gap", value: (r) => r.gap ?? "" },
		]);
		downloadCsv(`tunnel-map-${new Date().toISOString().slice(0, 10)}.csv`, csv);
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
						placeholder="Search hostname, app, policy, tunnel, origin…"
						aria-label="Search the tunnel map"
						className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</div>
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{rows.length.toLocaleString()} of {(result?.rows ?? []).length.toLocaleString()}
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

			{/* Cloudflare answers an unpermitted tunnel list with 200 and an empty result rather
			    than 403, so an empty map is ambiguous. Say so instead of rendering a blank table
			    that looks like a clean bill of health. */}
			{result && result.tunnels.length === 0 && (
				<div role="status" className="mb-4 rounded-lg border border-amber-300/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
					No tunnels were returned for this account. If you expect some, the API token is missing{" "}
					<strong>Cloudflare Tunnel: Read</strong> — Cloudflare returns an empty list for that rather than an error,
					so this cannot be told apart from an account with no tunnels. Only the Access half of each row is shown
					below.
				</div>
			)}

			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
				<div className={CARD}>
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Tunnels</div>
					<div className="mt-1 text-2xl font-semibold tabular-nums">{result?.tunnels.length ?? 0}</div>
				</div>
				<div className={CARD}>
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Mapped hostnames</div>
					<div className="mt-1 text-2xl font-semibold tabular-nums">{mapped}</div>
					<div className="mt-0.5 text-xs text-zinc-400">app + tunnel + origin</div>
				</div>
				<div className={CARD}>
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Ungated hostnames</div>
					<div className={`mt-1 text-2xl font-semibold tabular-nums ${ungated ? "text-red-600 dark:text-red-400" : ""}`}>
						{ungated}
					</div>
					<div className="mt-0.5 text-xs text-zinc-400">tunnel ingress with no Access app</div>
				</div>
				<div className={CARD}>
					<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Private routes</div>
					<div className="mt-1 text-2xl font-semibold tabular-nums">{result?.privateRoutes.length ?? 0}</div>
				</div>
			</div>

			<section className={`${CARD} mb-4`}>
				<h2 className="mb-3 text-sm font-semibold">Hostname → policy → tunnel → origin</h2>
				{rows.length === 0 ? (
					<p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
						{loading ? "Loading…" : "Nothing to show for this search."}
					</p>
				) : (
					<ul className="space-y-2">
						{rows.map((row) => (
							<li
								key={`${row.hostname}|${row.path ?? ""}|${row.service}|${row.tunnel?.id ?? ""}`}
								className="rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
							>
								<div className="grid gap-3 md:grid-cols-[1.4fr_1.4fr_1fr_1.2fr]">
									<Hop label="Destination">
										<span className="font-medium">{row.hostname}</span>
										{row.path && <span className="text-zinc-500">{row.path}</span>}
									</Hop>
									<Hop label="Access policy">
										{row.app ? (
											<span className="flex flex-wrap items-center gap-1">
												<span className="truncate" title={row.app.name}>{row.app.name}</span>
												{row.app.policiesError ? (
													<span className="text-xs text-amber-600 dark:text-amber-400">policies unavailable</span>
												) : row.app.policies.length ? (
													row.app.policies.map((p) => <DecisionChip key={p.name + p.decision} decision={p.decision} />)
												) : (
													<span className="text-xs text-red-600 dark:text-red-400">no policies</span>
												)}
											</span>
										) : (
											<span className="text-zinc-400">—</span>
										)}
									</Hop>
									<Hop label="Tunnel">
										{row.tunnel ? (
											<span className="truncate" title={row.tunnel.name}>
												{row.tunnel.name}{" "}
												<span className={`text-xs ${statusTone(row.tunnel.status)}`}>{row.tunnel.status}</span>
											</span>
										) : (
											<span className="text-zinc-400">—</span>
										)}
									</Hop>
									<Hop label="Origin">
										<span className="font-mono text-xs">{row.service}</span>
									</Hop>
								</div>
								{row.gap && (
									<div className="mt-1.5">
										<GapBadge gap={row.gap} />
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			<div className="grid gap-4 lg:grid-cols-2">
				<section className={CARD}>
					<h2 className="mb-3 text-sm font-semibold">Tunnels</h2>
					{(result?.tunnels.length ?? 0) === 0 ? (
						<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">None returned.</p>
					) : (
						<ul className="space-y-2 text-sm">
							{result?.tunnels.map((tunnel) => (
								<li key={tunnel.id} className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="truncate font-medium" title={tunnel.id}>{tunnel.name}</span>
									<span className="flex items-center gap-2 text-xs">
										<span className={statusTone(tunnel.status)}>{tunnel.status}</span>
										{tunnel.colos.length > 0 && <span className="text-zinc-400">{tunnel.colos.join(", ")}</span>}
										{tunnel.configError && (
											<span className="text-amber-600 dark:text-amber-400" title={tunnel.configError}>
												config unavailable
											</span>
										)}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className={CARD}>
					<h2 className="mb-3 text-sm font-semibold">Private network routes</h2>
					{(result?.privateRoutes.length ?? 0) === 0 ? (
						<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">None returned.</p>
					) : (
						<ul className="space-y-2 text-sm">
							{result?.privateRoutes.map((route) => (
								<li key={`${route.tunnelId}|${route.network}`} className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="font-mono text-xs">{route.network}</span>
									<span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
										{route.tunnelName}
										{route.comment ? ` · ${route.comment}` : ""}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

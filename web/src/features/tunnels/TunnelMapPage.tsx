import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { EmptyNote } from "../../components/EmptyState";
import { StatCard, StatGrid } from "../../components/StatCard";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, ALERT_WARN, BTN_SECONDARY, CARD, FOCUS_RING, MUTED, SEARCH_INPUT, SECTION_TITLE } from "../../lib/ui";
import { cacheAgeLabel } from "../../lib/edge-cache-caption";
import { SearchIcon } from "../../components/Icons";
import { downloadCsv, toCsv } from "../../lib/csv";
import type { Session } from "../../hooks/useSession";
import { useTunnelMap } from "./useTunnelMap";
import { TunnelSankey } from "./TunnelSankey";
import { TunnelDrawer } from "./TunnelDrawer";
import { appTypeLabel, chainText, originKindLabel, statusTone, type MappingRow, type OriginKind } from "./types";
import { compareCloudflaredVersions } from "./cloudflared-version";


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
					: "A self-hosted destination with no tunnel ingress serving it. Its origin may be public, or reached some other way worth confirming."
			}
		>
			{isUngated ? "No Access app" : "No route found"}
		</span>
	);
}

/** Where the traffic terminates. Muted for the kinds that never involve a tunnel. */
function KindChip({ kind }: { kind: OriginKind }) {
	const tone =
		kind === "tunnel"
			? "bg-cf/15 text-cf"
			: kind === "worker"
				? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
				: kind === "private"
					? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
					: kind === "cloudflare"
						? "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"
						: "bg-amber-500/10 text-amber-700 dark:text-amber-400";
	return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{originKindLabel(kind)}</span>;
}

/** One hop of the chain. Kept flat so a row reads left to right like the path a request takes. */
function Hop({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0">
			<div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
			<div className="truncate text-sm">{children}</div>
		</div>
	);
}

export function TunnelMapPage({ session, onAuthError }: { session: Session; onAuthError: () => void }) {
	const [search, setSearch] = useState("");
	const [openTunnelId, setOpenTunnelId] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const { result, loading, error, cachedAt, progress, load } = useTunnelMap(onAuthError);
	// Looked up by id so a Sync refreshes an open drawer rather than leaving it on stale data.
	const openTunnel = result?.tunnels.find((t) => t.id === openTunnelId) ?? null;
	// Only a Sync-triggered reload should bypass the cache — a mount or account switch should
	// still get the fast cached read. The ref survives the render that clears reloadKey's effect
	// dependency change; the effect below reads and resets it.
	const freshOnNextLoadRef = useRef(false);
	useSectionRefresh(
		useCallback(() => {
			freshOnNextLoadRef.current = true;
			setReloadKey((k) => k + 1);
		}, []),
		loading,
	);

	useEffect(() => {
		const fresh = freshOnNextLoadRef.current;
		freshOnNextLoadRef.current = false;
		load(session.token, session.accountId, fresh);
	}, [session.token, session.accountId, reloadKey, load]);

	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		const all = result?.rows ?? [];
		return q ? all.filter((row) => chainText(row).toLowerCase().includes(q)) : all;
	}, [result, search]);

	const ungated = (result?.rows ?? []).filter((r) => r.gap === "no-access-app").length;
	const mapped = (result?.rows ?? []).filter((r) => !r.gap).length;
	const unrouted = (result?.rows ?? []).filter((r) => r.gap === "no-tunnel").length;

	function exportCsv() {
		const csv = toCsv(rows, [
			{ header: "hostname", value: (r) => r.hostname },
			{ header: "path", value: (r) => r.path ?? "" },
			{ header: "access_app", value: (r) => r.app?.name ?? "" },
			{ header: "app_type", value: (r) => appTypeLabel(r.app?.type) },
			{ header: "policies", value: (r) => (r.app ? r.app.policies.map((p) => `${p.name} (${p.decision})`).join(" | ") : "") },
			{ header: "tunnel", value: (r) => r.tunnel?.name ?? "" },
			{ header: "tunnel_status", value: (r) => r.tunnel?.status ?? "" },
			{ header: "origin", value: (r) => r.service },
			{ header: "origin_kind", value: (r) => originKindLabel(r.originKind) },
			{ header: "gap", value: (r) => r.gap ?? "" },
		]);
		downloadCsv(`tunnel-map-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	return (
		<PageShell progress={progress}>
			{cachedAt && <p className={`text-xs ${MUTED}`}>{cacheAgeLabel(cachedAt)}</p>}

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-72">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search hostname, app, policy, tunnel, origin…"
						aria-label="Search the tunnel map"
						className={SEARCH_INPUT}
					/>
				</div>
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{rows.length.toLocaleString()} of {(result?.rows ?? []).length.toLocaleString()}
				</span>
				<button
					type="button"
					onClick={exportCsv}
					disabled={!rows.length}
					className={BTN_SECONDARY}
				>
					Export CSV
				</button>
			</div>


			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{result?.errors.map((e) => (
				<div key={e.source} role="status" className={ALERT_WARN}>
					{e.source}: {e.message}
				</div>
			))}

			{/* Cloudflare answers an unpermitted tunnel list with 200 and an empty result rather
			    than 403, so an empty map is ambiguous. Say so instead of rendering a blank table
			    that looks like a clean bill of health. */}
			{result && result.tunnels.length === 0 && (
				<div role="status" className={ALERT_WARN}>
					No tunnels were returned for this account. If you expect some, the API token is missing{" "}
					<strong>Cloudflare Tunnel: Read</strong> — Cloudflare returns an empty list for that rather than an error,
					so this cannot be told apart from an account with no tunnels. Only the Access half of each row is shown
					below.
				</div>
			)}

			<StatGrid cols={4}>
				<StatCard label="Tunnels" value={result?.tunnels.length ?? 0} />
				<StatCard label="Mapped hostnames" value={mapped} hint="app + tunnel + origin" />
				<StatCard
					label="Ungated hostnames"
					value={ungated}
					hint="tunnel ingress with no Access app"
					tone={ungated ? "text-red-600 dark:text-red-400" : undefined}
				/>
				<StatCard
					label="No route found"
					value={unrouted}
					hint="self-hosted, no tunnel ingress"
					tone={unrouted ? "text-amber-700 dark:text-amber-400" : undefined}
				/>
			</StatGrid>

			{/* Proportion first, then the rows. The table says what each destination is; only the
			    flow can say that most of the estate is gated yet reaches no tunnel. Filtered rows
			    feed it, so the picture always describes what is listed below it. */}
			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Access → tunnel → origin</h2>
				{rows.length === 0 ? (
					<EmptyNote title="No matching hostnames" loading={loading} />
				) : (
					<TunnelSankey rows={rows} onSelectTunnel={setSearch} />
				)}
			</section>

			<section className={`${CARD}`}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Destination → application → route → origin</h2>
				{rows.length === 0 ? (
					<EmptyNote title="No matching hostnames" loading={loading} />
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
												<span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
													{appTypeLabel(row.app.type)}
												</span>
												{row.app.policiesError ? (
													<span className="text-xs text-amber-600 dark:text-amber-400">policies unavailable</span>
												) : row.app.policies.length ? (
													row.app.policies.map((p) => <DecisionChip key={p.name + p.decision} decision={p.decision} />)
												) : (
													<span className="text-xs text-red-600 dark:text-red-400">no policies</span>
												)}
											</span>
										) : (
											<span className="text-zinc-500 dark:text-zinc-400">—</span>
										)}
									</Hop>
									<Hop label="Tunnel">
										{row.tunnel ? (
											<span className="truncate" title={row.tunnel.name}>
												{row.tunnel.name}{" "}
												<span className={`text-xs ${statusTone(row.tunnel.status)}`}>{row.tunnel.status}</span>
											</span>
										) : (
											<span className="text-zinc-500 dark:text-zinc-400">—</span>
										)}
									</Hop>
									<Hop label="Origin">
										<span className="flex flex-wrap items-center gap-1.5">
											<span className="truncate font-mono text-xs" title={row.service}>{row.service}</span>
											<KindChip kind={row.originKind} />
										</span>
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
					<h2 className={`mb-3 ${SECTION_TITLE}`}>
						Tunnels
						{result?.latestCloudflared && "version" in result.latestCloudflared && (
							<span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
								latest cloudflared: {result.latestCloudflared.version}
							</span>
						)}
					</h2>
					{(result?.tunnels.length ?? 0) === 0 ? (
						<p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">None returned.</p>
					) : (
						<ul className="space-y-2 text-sm">
							{result?.tunnels.map((tunnel) => (
								<li key={tunnel.id}>
									<button
										type="button"
										onClick={() => setOpenTunnelId(tunnel.id)}
										className={`-mx-2 flex w-[calc(100%+1rem)] flex-wrap items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${FOCUS_RING}`}
									>
										<span className="truncate font-medium">{tunnel.name}</span>
										<span className="flex flex-wrap items-center gap-2 text-xs">
											<span className={statusTone(tunnel.status)}>{tunnel.status}</span>
											{!tunnel.connectorsError && (
												<span className="text-zinc-500 dark:text-zinc-400">
													{tunnel.connectors.length} {tunnel.connectors.length === 1 ? "connector" : "connectors"}
												</span>
											)}
											{tunnel.colos.length > 0 && <span className="text-zinc-500 dark:text-zinc-400">{tunnel.colos.join(", ").toUpperCase()}</span>}
											{result?.latestCloudflared &&
												"version" in result.latestCloudflared &&
												tunnel.connectors.some((c) => compareCloudflaredVersions(c.version, (result.latestCloudflared as { version: string }).version) === -1) && (
													<span className="text-amber-600 dark:text-amber-400" title={`A connector on this tunnel is behind the latest cloudflared release (${result.latestCloudflared.version}).`}>
														outdated
													</span>
												)}
											{tunnel.health.some((n) => n.level === "warn") && (
												<span className="text-amber-600 dark:text-amber-400">
													{tunnel.health.filter((n) => n.level === "warn").length} warning
													{tunnel.health.filter((n) => n.level === "warn").length === 1 ? "" : "s"}
												</span>
											)}
											{tunnel.configError && (
												<span className="text-amber-600 dark:text-amber-400" title={tunnel.configError}>
													config unavailable
												</span>
											)}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className={CARD}>
					<h2 className={`mb-3 ${SECTION_TITLE}`}>Private network routes</h2>
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
			{openTunnel && (
				<TunnelDrawer
					key={openTunnel.id}
					tunnel={openTunnel}
					rows={result?.rows ?? []}
					privateRoutes={result?.privateRoutes ?? []}
					latestCloudflared={result?.latestCloudflared}
					token={session.token}
					accountId={session.accountId}
					onClose={() => setOpenTunnelId(null)}
				/>
			)}
		</PageShell>
	);
}

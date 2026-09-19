import { useRef, useState } from "react";
import { XIcon } from "../../components/Icons";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { ApiError } from "../../api/client";
import { fetchTunnelMetrics } from "../../api/client";
import { ALERT_WARN, BADGE, BADGE_NEUTRAL, BTN_SECONDARY, MUTED } from "../../lib/ui";
import { relativeTime } from "../../lib/waf/format";
import {
	statusTone,
	type LatestCloudflared,
	type MappingRow,
	type PrivateRoute,
	type TunnelConnector,
	type TunnelMetrics,
	type TunnelSummary,
} from "./types";
import { compareCloudflaredVersions } from "./cloudflared-version";

/** `cloudflared` opens four edge connections per process. Mirrors the worker's constant. */
const EXPECTED_CONNECTIONS = 4;

const HEADING = "mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

function when(iso?: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? `${d.toLocaleString()} (${relativeTime(iso)})` : "—";
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex justify-between gap-3 text-sm">
			<dt className={MUTED}>{label}</dt>
			<dd className="min-w-0 truncate text-right">{children}</dd>
		</div>
	);
}

function LatestBadge({ version, latest }: { version: string; latest?: LatestCloudflared }) {
	if (!latest || "error" in latest) return null;
	const cmp = compareCloudflaredVersions(version, latest.version);
	if (cmp === null || cmp >= 0) return null;
	return (
		<span className="text-[11px] text-zinc-500 dark:text-zinc-400" title={`Latest cloudflared release: ${latest.version}`}>
			(latest: {latest.version})
		</span>
	);
}

function ConnectorCard({ connector, skew, latest }: { connector: TunnelConnector; skew: boolean; latest?: LatestCloudflared }) {
	const live = connector.connections.filter((c) => !c.pendingReconnect).length;
	const short = live < EXPECTED_CONNECTIONS;
	return (
		<li className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-xs" title={connector.id}>{connector.id.slice(0, 8) || "unknown"}</span>
				<span className={`${BADGE} ${skew ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : BADGE_NEUTRAL}`} title={skew ? "Differs from another connector on this tunnel" : undefined}>
					cloudflared {connector.version}
				</span>
				<LatestBadge version={connector.version} latest={latest} />
				<span className={BADGE_NEUTRAL}>{connector.arch}</span>
				<span className={`ml-auto text-xs font-medium ${short ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
					{live}/{EXPECTED_CONNECTIONS} connections
				</span>
			</div>
			<p className={`mt-1 text-xs ${MUTED}`}>Started {when(connector.startedAt)}</p>
			{connector.connections.length > 0 && (
				<table className="mt-2 w-full text-xs">
					<thead>
						<tr className={`text-left ${MUTED}`}>
							<th className="py-1 pr-2 font-medium">Data center</th>
							<th className="py-1 pr-2 font-medium">Opened</th>
							<th className="py-1 pr-2 font-medium">From IP</th>
							<th className="py-1 font-medium">State</th>
						</tr>
					</thead>
					<tbody>
						{connector.connections.map((conn) => (
							<tr key={conn.id} className="border-t border-zinc-100 dark:border-zinc-800">
								<td className="py-1 pr-2 font-mono uppercase">{conn.colo}</td>
								<td className="py-1 pr-2" title={conn.openedAt}>{conn.openedAt ? relativeTime(conn.openedAt) : "—"}</td>
								<td className="py-1 pr-2 font-mono">{conn.originIp || "—"}</td>
								<td className={`py-1 ${conn.pendingReconnect ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
									{conn.pendingReconnect ? "reconnecting" : "connected"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{connector.features.length > 0 && (
				<p className={`mt-2 text-[11px] ${MUTED}`}>Features: {connector.features.slice().sort().join(", ")}</p>
			)}
		</li>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes.toFixed(0)} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	const minutes = seconds / 60;
	if (minutes < 60) return `${minutes.toFixed(0)}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${hours.toFixed(1)}h`;
	return `${(hours / 24).toFixed(1)}d`;
}

type MetricsState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "loaded"; metrics: TunnelMetrics; fetchedAt: string };

/**
 * Connector CPU/memory/HA metrics. Cloudflare's API never reports these — they only exist on the
 * `cloudflared` process's own Prometheus endpoint, which an operator may optionally publish and
 * point this deployment at via the `TUNNEL_METRICS` secret (see README). `hasMetricsTarget` tells
 * the client only whether a target is configured, never the URL itself.
 */
function MetricsSection({ tunnelId, hasMetricsTarget, token, accountId }: { tunnelId: string; hasMetricsTarget?: boolean; token: string; accountId: string }) {
	const [state, setState] = useState<MetricsState>({ status: "idle" });

	if (!hasMetricsTarget) {
		return (
			<p className={`mt-2 text-[11px] ${MUTED}`}>
				CPU and memory are not reported by Cloudflare's API. cloudflared exposes them only on its own
				Prometheus metrics endpoint. This tunnel has no metrics target configured — see the README's
				"Connector metrics" setup section to publish one.
			</p>
		);
	}

	async function load() {
		setState({ status: "loading" });
		try {
			const result = await fetchTunnelMetrics<{ metrics: TunnelMetrics; fetchedAt: string }>(token, accountId, tunnelId);
			setState({ status: "loaded", metrics: result.metrics, fetchedAt: result.fetchedAt });
		} catch (err) {
			setState({ status: "error", message: err instanceof ApiError ? err.message : "Failed to load metrics." });
		}
	}

	return (
		<div className="mt-2">
			{state.status !== "loaded" && (
				<button type="button" onClick={load} disabled={state.status === "loading"} className={BTN_SECONDARY}>
					{state.status === "loading" ? "Loading…" : "Load metrics"}
				</button>
			)}
			{state.status === "error" && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.message}</p>}
			{state.status === "loaded" && (
				<div className="mt-1 space-y-1.5 text-xs">
					<div className="flex justify-between gap-3">
						<dt className={MUTED}>Memory (RSS)</dt>
						<dd>{state.metrics.processResidentMemoryBytes !== undefined ? formatBytes(state.metrics.processResidentMemoryBytes) : "—"}</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className={MUTED} title="Cumulative CPU time divided by process uptime — an average, not an instantaneous reading.">
							CPU (average since start)
						</dt>
						<dd>
							{state.metrics.processCpuSecondsTotal !== undefined && state.metrics.processStartTimeSeconds !== undefined
								? (() => {
										// As-of the fetch, not a live clock: this is a snapshot, not a ticking value.
										const uptime = new Date(state.fetchedAt).getTime() / 1000 - state.metrics.processStartTimeSeconds!;
										return uptime > 0 ? `${((state.metrics.processCpuSecondsTotal! / uptime) * 100).toFixed(1)}%` : "—";
									})()
								: state.metrics.processCpuSecondsTotal !== undefined
									? `${state.metrics.processCpuSecondsTotal.toFixed(0)}s CPU time (no start time)`
									: "—"}
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className={MUTED}>HA connections</dt>
						<dd>{state.metrics.haConnections ?? "—"}</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className={MUTED}>Requests / errors</dt>
						<dd>
							{state.metrics.totalRequests ?? "—"} / {state.metrics.requestErrors ?? "—"}
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className={MUTED}>Concurrent requests</dt>
						<dd>{state.metrics.concurrentRequests ?? "—"}</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className={MUTED}>Process uptime</dt>
						<dd>
							{state.metrics.processStartTimeSeconds !== undefined
								? formatDuration(new Date(state.fetchedAt).getTime() / 1000 - state.metrics.processStartTimeSeconds)
								: "—"}
						</dd>
					</div>
					<p className={`pt-1 text-[11px] ${MUTED}`}>Fetched {relativeTime(state.fetchedAt)}.</p>
					<button type="button" onClick={load} className={`${BTN_SECONDARY} mt-1`}>
						Reload metrics
					</button>
				</div>
			)}
		</div>
	);
}

interface TunnelDrawerProps {
	tunnel: TunnelSummary;
	rows: MappingRow[];
	privateRoutes: PrivateRoute[];
	latestCloudflared?: LatestCloudflared;
	token: string;
	accountId: string;
	onClose: () => void;
}

/** Everything the API says about one tunnel: its connectors, their edge connections, and what it serves. */
export function TunnelDrawer({ tunnel, rows, privateRoutes, latestCloudflared, token, accountId, onClose }: TunnelDrawerProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	useFocusTrap(panelRef, true, onClose);

	const served = rows.filter((r) => r.tunnel?.id === tunnel.id);
	const routes = privateRoutes.filter((r) => r.tunnelId === tunnel.id);
	const versions = new Set(tunnel.connectors.map((c) => c.version));

	return (
		<div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Details for tunnel ${tunnel.name}`}>
			<button type="button" aria-label="Close details" className="absolute inset-0 bg-black/50" onClick={onClose} />
			<div
				ref={panelRef}
				className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[32rem] md:rounded-none dark:bg-zinc-900"
			>
				<div className="sticky top-0 flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
					<div className="min-w-0">
						<h2 className="truncate text-base font-semibold">{tunnel.name}</h2>
						<p className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{tunnel.id}</p>
					</div>
					<button
						type="button"
						autoFocus
						onClick={onClose}
						aria-label="Close"
						className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
					>
						<XIcon size={18} />
					</button>
				</div>

				<div className="space-y-5 px-5 py-5">
					<dl className="space-y-1.5">
						<Fact label="Status"><span className={`font-medium ${statusTone(tunnel.status)}`}>{tunnel.status}</span></Fact>
						<Fact label="Configured in">
							{tunnel.configSource === "cloudflare" ? "Cloudflare dashboard / API" : tunnel.configSource === "local" ? "Local config file" : "—"}
						</Fact>
						<Fact label="Connected since">{when(tunnel.activeSince)}</Fact>
						{tunnel.inactiveSince && <Fact label="Last disconnected">{when(tunnel.inactiveSince)}</Fact>}
						<Fact label="Created">{when(tunnel.createdAt)}</Fact>
						<Fact label="Data centers">{tunnel.colos.length ? tunnel.colos.join(", ").toUpperCase() : "—"}</Fact>
					</dl>

					{tunnel.health.length > 0 && (
						<ul className="space-y-1.5">
							{tunnel.health.map((note) => (
								<li
									key={note.message}
									className={
										note.level === "warn"
											? `${ALERT_WARN} !px-3 !py-2 text-xs`
											: "rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
									}
								>
									{note.message}
								</li>
							))}
						</ul>
					)}

					<section>
						<h3 className={HEADING}>Connectors ({tunnel.connectors.length})</h3>
						{tunnel.connectorsError ? (
							<p className={`${ALERT_WARN} !px-3 !py-2 text-xs`}>
								Connectors could not be read: {tunnel.connectorsError}. This is not the same as none running.
							</p>
						) : tunnel.connectors.length === 0 ? (
							<p className={`text-sm ${MUTED}`}>No cloudflared connector is running for this tunnel.</p>
						) : (
							<ul className="space-y-2">
								{tunnel.connectors.map((c) => (
									<ConnectorCard key={c.id} connector={c} skew={versions.size > 1} latest={latestCloudflared} />
								))}
							</ul>
						)}
						<MetricsSection tunnelId={tunnel.id} hasMetricsTarget={tunnel.hasMetricsTarget} token={token} accountId={accountId} />
					</section>

					<section>
						<h3 className={HEADING}>Public hostnames ({served.length})</h3>
						{tunnel.configError ? (
							<p className={`${ALERT_WARN} !px-3 !py-2 text-xs`}>Ingress could not be read: {tunnel.configError}</p>
						) : served.length === 0 ? (
							<p className={`text-sm ${MUTED}`}>None.</p>
						) : (
							<ul className="space-y-1 text-xs">
								{served.map((r) => (
									<li key={`${r.hostname}|${r.path ?? ""}|${r.service}`} className="flex justify-between gap-3">
										<span className="min-w-0 truncate font-medium" title={r.hostname}>
											{r.hostname}{r.path ? ` ${r.path}` : ""}
										</span>
										<span className={`min-w-0 truncate font-mono ${MUTED}`} title={r.service}>{r.service}</span>
									</li>
								))}
							</ul>
						)}
					</section>

					{routes.length > 0 && (
						<section>
							<h3 className={HEADING}>Private network routes ({routes.length})</h3>
							<ul className="space-y-1 text-xs">
								{routes.map((r) => (
									<li key={r.network} className="flex justify-between gap-3">
										<span className="font-mono">{r.network}</span>
										{r.comment && <span className={`truncate ${MUTED}`}>{r.comment}</span>}
									</li>
								))}
							</ul>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

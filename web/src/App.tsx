import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAccounts, fetchConfig } from "./api/client";
import type { CfAccount } from "./types";
import { ConnectPage } from "./components/connect/ConnectPage";
import { Dashboard } from "./features/access/Dashboard";
import { GroupsPage } from "./features/access/GroupsPage";
import { CachePage } from "./features/cache/CachePage";
import { FindingsPage } from "./features/findings/FindingsPage";
import { WafPage } from "./features/waf/WafPage";
import { WorkersPage } from "./features/workers/WorkersPage";
import { AccessUsagePage } from "./features/access-usage/AccessUsagePage";
import { WorkersAiPage } from "./features/workers-ai/WorkersAiPage";
import { GatewayPage } from "./features/gateway/GatewayPage";
import { TunnelMapPage } from "./features/tunnels/TunnelMapPage";
import { RequestTracePage } from "./features/request/RequestTracePage";
import { CostPage } from "./features/cost/CostPage";
import { AiSecurityPage } from "./features/ai-security/AiSecurityPage";
import { Sidebar, type AppVersion } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { useHashSyncedState } from "./hooks/useHashParams";
import { usePrefs } from "./hooks/usePrefs";
import { TIME_RANGE_ROUTES, useTimeRange } from "./hooks/useTimeRange";
import { useRoute, type Route } from "./hooks/useRoute";
import { useSession, type Session } from "./hooks/useSession";
import { useZeroTrustData } from "./hooks/useZeroTrustData";
import { useZones } from "./hooks/useZones";
import type { RuleContext } from "./lib/rules";
import { clearSectionSnapshots } from "./lib/sectionSnapshot";

const PAGE_TITLES: Record<Route, string> = {
	access: "Access Applications",
	groups: "Access Groups",
	waf: "WAF Analytics",
	cache: "Cache Rules",
	"ai-security": "AI Security for Apps",
	workers: "Workers Analytics",
	"access-usage": "Access Usage",
	"workers-ai": "Workers AI",
	request: "Request Trace",
	tunnels: "Tunnel Map",
	gateway: "Gateway Usage",
	cost: "Cost & Usage",
	findings: "Findings",
};

export default function App() {
	const { session, connect, disconnect } = useSession();
	const { prefs, updatePrefs } = usePrefs();
	const timeRange = useTimeRange(prefs, updatePrefs);
	const [route, navigate] = useRoute();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	// Disconnecting must not leave one customer's telemetry in memory for
	// whoever connects next on this browser.
	const handleDisconnect = useCallback(() => {
		clearSectionSnapshots();
		disconnect();
	}, [disconnect]);

	const handleAuthError = handleDisconnect;

	// Which credential model this deployment uses. Resolved once, before anything renders: in
	// server mode the worker holds the token and Cloudflare Access has already authenticated the
	// operator, so there is nothing to ask them for. A server-mode session is deliberately not
	// persisted — it is re-derived here on every load, and cannot outlive the Access session.
	const [bootstrapped, setBootstrapped] = useState(false);
	const [serverAccounts, setServerAccounts] = useState<{ id: string; name: string }[]>([]);
	const [appVersion, setAppVersion] = useState<AppVersion | undefined>(undefined);
	const [bootstrapError, setBootstrapError] = useState("");

	useEffect(() => {
		let cancelled = false;
		fetchConfig()
			.then((config) => {
				if (cancelled) return;
				setAppVersion(config.version);
				if (config.mode === "server") {
					const allowed = config.accounts || [];
					setServerAccounts(allowed);
					if (allowed.length === 1) {
						connect({ token: "", accountId: allowed[0].id, accountName: allowed[0].name, mode: "server" });
					} else if (allowed.length === 0) {
						setBootstrapError(
							config.accountsError ||
								"This deployment is configured for automatic sign-in, but no account is available to it.",
						);
					}
				}
			})
			.catch(() => {
				// A failed probe is not fatal: fall back to asking for a token.
			})
			.finally(() => !cancelled && setBootstrapped(true));
		return () => {
			cancelled = true;
		};
	}, [connect]);

	const data = useZeroTrustData(handleAuthError);
	const { load } = data;
	const zones = useZones();

	const sessionToken = session?.token;
	const sessionAccountId = session?.accountId;

	useEffect(() => {
		// `sessionToken` is empty in server mode, so the account id is what says "connected".
		if (sessionAccountId) {
			load(sessionToken || "", sessionAccountId);
		}
	}, [sessionToken, sessionAccountId, load]);

	// Zone list is only needed by zone-scoped features; fetch on first visit
	const ensureZones = zones.ensureLoaded;
	useEffect(() => {
		if (sessionAccountId && (route === "waf" || route === "cache" || route === "ai-security" || route === "request")) {
			ensureZones(sessionToken || "", sessionAccountId);
		}
	}, [route, sessionToken, sessionAccountId, ensureZones]);

	// Accounts list powers the sidebar switcher (best-effort; single-account tokens skip it)
	const [accounts, setAccounts] = useState<CfAccount[]>([]);
	useEffect(() => {
		if (!sessionAccountId) return;
		let cancelled = false;
		fetchAccounts(sessionToken || "")
			.then((result) => !cancelled && setAccounts(result))
			.catch(() => !cancelled && setAccounts([]));
		return () => {
			cancelled = true;
		};
	}, [sessionToken, sessionAccountId]);

	// Deep-linkable zone for zone-scoped routes: #/waf?zone=… / #/cache?zone=…
	const activeZone =
		route === "waf" ? prefs.wafZone : route === "cache" ? prefs.cacheZone : route === "ai-security" ? prefs.aiSecZone : "";
	useHashSyncedState("zone", activeZone, (zoneId) => {
		if (route === "waf") updatePrefs({ wafZone: zoneId });
		else if (route === "cache") updatePrefs({ cacheZone: zoneId });
		else if (route === "ai-security") updatePrefs({ aiSecZone: zoneId });
	});

	const ctx = useMemo<RuleContext>(
		() => ({
			groupName: (id) => data.groupMap[id] || id,
			idpName: (id) => data.idpMap[id] || id,
		}),
		[data.groupMap, data.idpMap],
	);

	const handleConnect = useCallback((next: Session) => {
		connect(next);
	}, [connect]);

	if (!bootstrapped) {
		return (
			<div className="flex min-h-dvh items-center justify-center p-4 text-sm text-zinc-500 dark:text-zinc-400">
				Connecting…
			</div>
		);
	}

	if (!session) {
		return (
			<ConnectPage
				onConnect={handleConnect}
				serverAccounts={serverAccounts}
				serverError={bootstrapError}
				onPickServerAccount={(account) =>
					connect({ token: "", accountId: account.id, accountName: account.name, mode: "server" })
				}
			/>
		);
	}

	return (
		<div className="flex h-dvh overflow-hidden">
			<Sidebar
				accountId={session.accountId}
				accounts={accounts}
				onSwitchAccount={(account) => {
					connect({
						token: session.token,
						accountId: account.id,
						accountName: account.name || account.id,
						mode: session.mode,
					});
					zones.reset();
					updatePrefs({ wafZone: "", cacheZone: "", aiSecZone: "" });
				}}
				route={route}
				onNavigate={navigate}
				collapsed={prefs.sidebarCollapsed}
				onToggleCollapsed={() => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })}
				version={appVersion}
				mobileOpen={mobileMenuOpen}
				onMobileClose={() => setMobileMenuOpen(false)}
			/>
			{/* min-h-0 is load-bearing: a flex item defaults to min-height:auto, so without it this
			    column grows to fit its content instead of being bounded by the h-dvh shell. The
			    page inside then never becomes the scroll container — the shell's overflow-hidden
			    box scrolls instead, which drags the sidebar and top bar out of view. */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<Topbar
					title={PAGE_TITLES[route]}
					theme={prefs.theme}
					onToggleTheme={() => updatePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
					onSync={() => load(session.token, session.accountId)}
					syncing={data.loading}
					showSync={route === "access" || route === "groups" || route === "findings"}
					zonePicker={
						route === "waf"
							? {
								zones: zones.zones,
								value: prefs.wafZone,
								onChange: (zoneId) => updatePrefs({ wafZone: zoneId }),
								loading: zones.loading,
								accountWideLabel: "Account (all zones)",
							}
							: route === "cache"
								? {
									zones: zones.zones,
									value: prefs.cacheZone,
									onChange: (zoneId) => updatePrefs({ cacheZone: zoneId }),
									loading: zones.loading,
								}
								: route === "ai-security"
									? {
										zones: zones.zones,
										value: prefs.aiSecZone,
										onChange: (zoneId) => updatePrefs({ aiSecZone: zoneId }),
										loading: zones.loading,
										// The aggregation fans out across every visible zone when none is
										// picked, which is the useful default for "is anything wrong".
										accountWideLabel: "Account (all zones)",
									}
									: undefined
					}
					rangePicker={
						TIME_RANGE_ROUTES.has(route) ? { value: timeRange.preset, onChange: timeRange.setPreset } : undefined
					}
					onDisconnect={handleDisconnect}
					mode={session.mode}
					onMobileMenu={() => setMobileMenuOpen(true)}
				/>
				{/* `relative` is load-bearing. `overflow` does not create a containing block, so an
				    absolutely positioned descendant with no positioned ancestor — every `sr-only`
				    label, and icons inside inputs — anchors to the initial containing block instead
				    of the scroller. Deep in a long page those sit thousands of pixels down, which
				    stretches <html> and makes the whole document scrollable: the sidebar and top bar
				    then slide away with the content. */}
				<main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
					{route === "access" && (
						<Dashboard
							apps={data.data?.apps || []}
							idpCount={data.data?.idps.length || 0}
							loading={data.loading}
							error={data.error}
							progressPercent={data.progress.percent}
							progressRunning={data.progress.running}
							ctx={ctx}
							reusableMap={data.reusableMap}
							prefs={prefs}
							updatePrefs={updatePrefs}
						/>
					)}
					{route === "groups" && (
						<GroupsPage
							groups={data.data?.groups || []}
							groupsError={data.data?.groups_error || false}
							apps={data.data?.apps || []}
							reusableMap={data.reusableMap}
							loading={data.loading}
							error={data.error}
							progressPercent={data.progress.percent}
							progressRunning={data.progress.running}
							ctx={ctx}
						/>
					)}
					{route === "waf" && <WafPage session={session} zoneId={prefs.wafZone} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "cache" && <CachePage session={session} zoneId={prefs.cacheZone} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "ai-security" && (
						<AiSecurityPage session={session} zoneId={prefs.aiSecZone} timeRange={timeRange} onAuthError={handleDisconnect} />
					)}
					{route === "workers" && <WorkersPage session={session} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "access-usage" && <AccessUsagePage session={session} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "workers-ai" && <WorkersAiPage session={session} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "request" && <RequestTracePage session={session} zones={zones.zones} onAuthError={handleDisconnect} />}
					{route === "tunnels" && <TunnelMapPage session={session} onAuthError={handleDisconnect} />}
					{route === "gateway" && <GatewayPage session={session} timeRange={timeRange} onAuthError={handleDisconnect} />}
					{route === "cost" && (
						<CostPage
							session={session}
							timeRange={timeRange}
							prefs={prefs}
							updatePrefs={updatePrefs}
							onAuthError={handleDisconnect}
						/>
					)}
					{route === "findings" && (
						<FindingsPage
							accountId={session.accountId}
							apps={data.data?.apps || []}
							groups={data.data?.groups || []}
							reusableMap={data.reusableMap}
							loading={data.loading}
							error={data.error}
							progressPercent={data.progress.percent}
							progressRunning={data.progress.running}
							onNavigate={(href) => {
								window.location.hash = href.replace(/^#/, "");
							}}
						/>
					)}
				</main>
			</div>
		</div>
	);
}

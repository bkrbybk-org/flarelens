import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAccounts } from "./api/client";
import type { CfAccount } from "./types";
import { ConnectPage } from "./components/connect/ConnectPage";
import { Dashboard } from "./features/access/Dashboard";
import { GroupsPage } from "./features/access/GroupsPage";
import { CachePage } from "./features/cache/CachePage";
import { WafPage } from "./features/waf/WafPage";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { useHashSyncedState } from "./hooks/useHashParams";
import { usePrefs } from "./hooks/usePrefs";
import { useRoute, type Route } from "./hooks/useRoute";
import { useSession, type Session } from "./hooks/useSession";
import { useZeroTrustData } from "./hooks/useZeroTrustData";
import { useZones } from "./hooks/useZones";
import type { RuleContext } from "./lib/rules";

const PAGE_TITLES: Record<Route, string> = {
	access: "Access Applications",
	groups: "Access Groups",
	waf: "WAF Analytics",
	cache: "Cache Rules",
};

export default function App() {
	const { session, connect, disconnect } = useSession();
	const { prefs, updatePrefs } = usePrefs();
	const [route, navigate] = useRoute();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	const handleAuthError = useCallback(() => {
		disconnect();
	}, [disconnect]);

	const data = useZeroTrustData(handleAuthError);
	const { load } = data;
	const zones = useZones();

	const sessionToken = session?.token;
	const sessionAccountId = session?.accountId;

	useEffect(() => {
		if (sessionToken && sessionAccountId) {
			load(sessionToken, sessionAccountId);
		}
	}, [sessionToken, sessionAccountId, load]);

	// Zone list is only needed by zone-scoped features; fetch on first visit
	const ensureZones = zones.ensureLoaded;
	useEffect(() => {
		if (sessionToken && sessionAccountId && (route === "waf" || route === "cache")) {
			ensureZones(sessionToken, sessionAccountId);
		}
	}, [route, sessionToken, sessionAccountId, ensureZones]);

	// Accounts list powers the sidebar switcher (best-effort; single-account tokens skip it)
	const [accounts, setAccounts] = useState<CfAccount[]>([]);
	useEffect(() => {
		if (!sessionToken) return;
		let cancelled = false;
		fetchAccounts(sessionToken)
			.then((result) => !cancelled && setAccounts(result))
			.catch(() => !cancelled && setAccounts([]));
		return () => {
			cancelled = true;
		};
	}, [sessionToken]);

	// Deep-linkable zone for zone-scoped routes: #/waf?zone=… / #/cache?zone=…
	const activeZone = route === "waf" ? prefs.wafZone : route === "cache" ? prefs.cacheZone : "";
	useHashSyncedState("zone", activeZone, (zoneId) => {
		if (route === "waf") updatePrefs({ wafZone: zoneId });
		else if (route === "cache") updatePrefs({ cacheZone: zoneId });
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

	if (!session) {
		return <ConnectPage onConnect={handleConnect} />;
	}

	return (
		<div className="flex h-dvh overflow-hidden">
			<Sidebar
				accountName={session.accountName}
				accountId={session.accountId}
				accounts={accounts}
				onSwitchAccount={(account) => {
					connect({ token: session.token, accountId: account.id, accountName: account.name || account.id });
					zones.reset();
					updatePrefs({ wafZone: "", cacheZone: "" });
				}}
				route={route}
				onNavigate={navigate}
				onDisconnect={disconnect}
				mobileOpen={mobileMenuOpen}
				onMobileClose={() => setMobileMenuOpen(false)}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<Topbar
					title={PAGE_TITLES[route]}
					theme={prefs.theme}
					onToggleTheme={() => updatePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
					onSync={() => load(session.token, session.accountId)}
					syncing={data.loading}
					showSync={route === "access" || route === "groups"}
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
								: undefined
					}
					onMobileMenu={() => setMobileMenuOpen(true)}
				/>
				<main className="min-h-0 min-w-0 flex-1">
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
							loading={data.loading}
							error={data.error}
							progressPercent={data.progress.percent}
							progressRunning={data.progress.running}
							ctx={ctx}
						/>
					)}
					{route === "waf" && <WafPage session={session} zoneId={prefs.wafZone} onAuthError={disconnect} />}
					{route === "cache" && <CachePage session={session} zoneId={prefs.cacheZone} onAuthError={disconnect} />}
				</main>
			</div>
		</div>
	);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectPage } from "./components/connect/ConnectPage";
import { Dashboard } from "./features/access/Dashboard";
import { CachePage } from "./features/cache/CachePage";
import { WafPage } from "./features/waf/WafPage";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { usePrefs } from "./hooks/usePrefs";
import { useRoute, type Route } from "./hooks/useRoute";
import { useSession, type Session } from "./hooks/useSession";
import { useZeroTrustData } from "./hooks/useZeroTrustData";
import type { RuleContext } from "./lib/rules";

const PAGE_TITLES: Record<Route, string> = {
	access: "Access Applications",
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

	useEffect(() => {
		if (session) {
			load(session.token, session.accountId);
		}
		// Load once per session change; `load` identity churns with progress ticks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session?.accountId, session?.token]);

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
					showSync={route === "access"}
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
					{route === "waf" && <WafPage />}
					{route === "cache" && <CachePage />}
				</main>
			</div>
		</div>
	);
}

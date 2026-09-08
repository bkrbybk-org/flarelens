import type { Route } from "../../hooks/useRoute";
import type { CfAccount } from "../../types";
import {
	AlertIcon,
	AppsIcon,
	BoltIcon,
	ChartIcon,
	DatabaseIcon,
	GlobeIcon,
	KeyIcon,
	LockIcon,
	PanelLeftIcon,
	SearchIcon,
	ShareIcon,
	ShieldIcon,
	SparkIcon,
	UsersIcon,
	XIcon,
} from "../Icons";

export interface AppVersion {
	id: string;
	tag?: string;
	/** ISO instant the running version was deployed. */
	timestamp?: string;
}

interface SidebarProps {
	accountId: string;
	accounts: CfAccount[];
	onSwitchAccount: (account: CfAccount) => void;
	route: Route;
	onNavigate: (route: Route) => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	version?: AppVersion;
	mobileOpen: boolean;
	onMobileClose: () => void;
}

/**
 * Navigation grouped by the Cloudflare product area each section reads from.
 *
 * A flat list stopped scanning well at eight entries and more are coming; grouping keeps the
 * "where would that live" question answerable without reading every label.
 */
const NAV_GROUPS: { label: string; items: { route: Route; label: string; icon: typeof AppsIcon }[] }[] = [
	{
		label: "Zero Trust",
		items: [
			{ route: "access", label: "Access Applications", icon: AppsIcon },
			{ route: "groups", label: "Access Groups", icon: UsersIcon },
			{ route: "access-usage", label: "Access Usage", icon: ChartIcon },
			{ route: "tunnels", label: "Tunnel Map", icon: ShareIcon },
			{ route: "gateway", label: "Gateway Usage", icon: GlobeIcon },
		],
	},
	{
		label: "Security",
		items: [
			{ route: "waf", label: "WAF Analytics", icon: ShieldIcon },
			{ route: "ai-security", label: "AI Security", icon: KeyIcon },
			{ route: "request", label: "Request Trace", icon: SearchIcon },
			{ route: "pqc", label: "PQC Readiness", icon: LockIcon },
		],
	},
	{
		label: "Performance",
		items: [{ route: "cache", label: "Cache Rules", icon: DatabaseIcon }],
	},
	{
		label: "Developer Platform",
		items: [
			{ route: "workers", label: "Workers Analytics", icon: BoltIcon },
			{ route: "workers-ai", label: "Workers AI", icon: SparkIcon },
			{ route: "cost", label: "Cost & Usage", icon: ChartIcon },
		],
	},
	{
		label: "Audit",
		items: [{ route: "findings", label: "Findings", icon: AlertIcon }],
	},
];

/** "4 Sep 2026, 20:55" — short, unambiguous, and local to whoever is reading it. */
function formatDeployed(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return date.toLocaleString([], {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

type ContentProps = Pick<
	SidebarProps,
	"accountId" | "accounts" | "onSwitchAccount" | "route" | "onNavigate" | "collapsed" | "onToggleCollapsed" | "version"
>;

function SidebarContent({
	accountId,
	accounts,
	onSwitchAccount,
	route,
	onNavigate,
	collapsed,
	onToggleCollapsed,
	version,
}: ContentProps) {
	return (
		<div className="flex h-full flex-col">
			<div className={`flex items-center py-5 ${collapsed ? "justify-center px-2" : "gap-2.5 px-5"}`}>
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cf/15 text-cf">
					<ShieldIcon size={20} />
				</span>
				{!collapsed && (
					<div className="leading-tight">
						<div className="text-sm font-semibold">Flarelens</div>
						<div className="text-xs text-zinc-500 dark:text-zinc-400">for Cloudflare</div>
					</div>
				)}
			</div>

			<nav className={`flex-1 overflow-y-auto py-2 ${collapsed ? "px-2" : "px-3"}`} aria-label="Main">
				{NAV_GROUPS.map((group) => (
					<div key={group.label} className="mb-3 last:mb-0">
						{collapsed ? (
							// Collapsed there is no room for a heading, but the grouping still needs
							// to read as groups rather than one long strip of icons.
							<div className="mx-auto mb-2 h-px w-6 bg-zinc-200 first:hidden dark:bg-zinc-800" aria-hidden />
						) : (
							<div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
								{group.label}
							</div>
						)}
						<div className="space-y-1">
							{group.items.map(({ route: itemRoute, label, icon: Icon }) => {
								const active = route === itemRoute;
								return (
									<button
										key={itemRoute}
										type="button"
										onClick={() => onNavigate(itemRoute)}
										aria-current={active ? "page" : undefined}
										title={collapsed ? label : undefined}
										className={`flex w-full items-center rounded-lg text-sm transition ${
											collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
										} ${
											active
												? "bg-cf/15 font-medium text-cf"
												: "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
										}`}
									>
										<Icon size={17} />
										{!collapsed && <span className="flex-1 text-left">{label}</span>}
									</button>
								);
							})}
						</div>
					</div>
				))}
			</nav>

			<div className={`border-t border-zinc-200 py-3 dark:border-zinc-800 ${collapsed ? "px-2" : "px-4"}`}>
				{/* The account switcher only appears when there is a choice to make; a single-account
				    deployment has nothing to switch between. */}
				{!collapsed && accounts.length > 1 && (
					<select
						value={accountId}
						onChange={(e) => {
							const next = accounts.find((a) => a.id === e.target.value);
							if (next && next.id !== accountId) onSwitchAccount(next);
						}}
						aria-label="Switch account"
						className="mb-2 w-full truncate rounded-md border border-zinc-200 bg-transparent px-1.5 py-1 text-xs outline-none focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
					>
						{accounts.map((a) => (
							<option key={a.id} value={a.id}>{a.name || a.id}</option>
						))}
					</select>
				)}

				{version ? (
					collapsed ? (
						<div
							className="text-center font-mono text-[10px] text-zinc-400"
							title={`Version ${version.id}${version.timestamp ? ` · deployed ${formatDeployed(version.timestamp)}` : ""}`}
						>
							{version.id.slice(0, 4)}
						</div>
					) : (
						<div className="leading-tight">
							<div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={version.id}>
								{version.tag || version.id.slice(0, 8)}
							</div>
							{version.timestamp && (
								<div className="text-[11px] text-zinc-400">Deployed {formatDeployed(version.timestamp)}</div>
							)}
						</div>
					)
				) : (
					!collapsed && <div className="text-[11px] text-zinc-400">Version unavailable</div>
				)}
			</div>

			{/* Bottom rail, like the Cloudflare dashboard's own sidebar: the control that changes
			    the sidebar's shape lives at its edge, not in the header competing with the brand. */}
			<div className={`border-t border-zinc-200 py-2 dark:border-zinc-800 ${collapsed ? "px-2" : "px-3"}`}>
				<button
					type="button"
					onClick={onToggleCollapsed}
					aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					className={`flex w-full items-center rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 ${
						collapsed ? "justify-center" : ""
					}`}
				>
					<PanelLeftIcon size={16} />
				</button>
			</div>
		</div>
	);
}

export function Sidebar({
	accountId,
	accounts,
	onSwitchAccount,
	route,
	onNavigate,
	collapsed,
	onToggleCollapsed,
	version,
	mobileOpen,
	onMobileClose,
}: SidebarProps) {
	const content = (mobile: boolean) => (
		<SidebarContent
			accountId={accountId}
			accounts={accounts}
			onSwitchAccount={onSwitchAccount}
			route={route}
			onNavigate={(r) => {
				onNavigate(r);
				if (mobile) onMobileClose();
			}}
			// The drawer is already a temporary surface; collapsing it there would be a second
			// hiding mechanism on top of the one the user just opened.
			collapsed={mobile ? false : collapsed}
			onToggleCollapsed={onToggleCollapsed}
			version={version}
		/>
	);

	return (
		<>
			{/* Desktop */}
			<aside
				className={`hidden shrink-0 border-r border-zinc-200 bg-white transition-[width] duration-200 md:block dark:border-zinc-800 dark:bg-zinc-900 ${
					collapsed ? "w-16" : "w-60"
				}`}
			>
				{content(false)}
			</aside>

			{/* Mobile overlay */}
			{mobileOpen && (
				<div className="fixed inset-0 z-40 md:hidden">
					<button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/50" onClick={onMobileClose} />
					<aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl dark:bg-zinc-900">
						<button
							type="button"
							aria-label="Close menu"
							onClick={onMobileClose}
							className="absolute right-3 top-4 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
						>
							<XIcon size={18} />
						</button>
						{content(true)}
					</aside>
				</div>
			)}
		</>
	);
}

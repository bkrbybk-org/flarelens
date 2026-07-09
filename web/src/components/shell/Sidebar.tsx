import type { Route } from "../../hooks/useRoute";
import { AppsIcon, GlobeIcon, LogoutIcon, ShieldIcon, XIcon } from "../Icons";

interface SidebarProps {
	accountName: string;
	route: Route;
	onNavigate: (route: Route) => void;
	onDisconnect: () => void;
	mobileOpen: boolean;
	onMobileClose: () => void;
}

const NAV_ITEMS: { route: Route; label: string; icon: typeof AppsIcon }[] = [
	{ route: "access", label: "Access Applications", icon: AppsIcon },
	{ route: "waf", label: "WAF Analytics", icon: ShieldIcon },
	{ route: "cache", label: "Cache Rules", icon: GlobeIcon },
];

type SidebarContentProps = Pick<SidebarProps, "accountName" | "route" | "onNavigate" | "onDisconnect">;

function SidebarContent({ accountName, route, onNavigate, onDisconnect }: SidebarContentProps) {
	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 px-5 py-5">
				<span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cf/15 text-cf">
					<ShieldIcon size={20} />
				</span>
				<div className="leading-tight">
					<div className="text-sm font-semibold">Cloudflare Ops</div>
					<div className="text-xs text-zinc-500 dark:text-zinc-400">Dashboard</div>
				</div>
			</div>

			<nav className="flex-1 space-y-1 px-3 py-2" aria-label="Main">
				{NAV_ITEMS.map(({ route: itemRoute, label, icon: Icon }) => {
					const active = route === itemRoute;
					return (
						<button
							key={itemRoute}
							type="button"
							onClick={() => onNavigate(itemRoute)}
							aria-current={active ? "page" : undefined}
							className={
								active
									? "flex w-full items-center gap-3 rounded-lg bg-cf/15 px-3 py-2 text-sm font-medium text-cf"
									: "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
							}
						>
							<Icon size={17} />
							<span className="flex-1 text-left">{label}</span>
						</button>
					);
				})}
			</nav>

			<div className="border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
				<div className="mb-3 flex items-center gap-2.5">
					<span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
					<div className="min-w-0 leading-tight">
						<div className="truncate text-sm font-medium" title={accountName}>{accountName}</div>
						<div className="text-xs text-zinc-500 dark:text-zinc-400">Connected</div>
					</div>
				</div>
				<button
					type="button"
					onClick={onDisconnect}
					className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-300/50 px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 dark:border-red-500/30 dark:text-red-400"
				>
					<LogoutIcon size={15} />
					Disconnect
				</button>
			</div>
		</div>
	);
}

export function Sidebar({ accountName, route, onNavigate, onDisconnect, mobileOpen, onMobileClose }: SidebarProps) {
	return (
		<>
			{/* Desktop */}
			<aside className="hidden w-60 shrink-0 border-r border-zinc-200 bg-white md:block dark:border-zinc-800 dark:bg-zinc-900">
				<SidebarContent accountName={accountName} route={route} onNavigate={onNavigate} onDisconnect={onDisconnect} />
			</aside>

			{/* Mobile overlay */}
			{mobileOpen && (
				<div className="fixed inset-0 z-40 md:hidden">
					<button
						type="button"
						aria-label="Close menu"
						className="absolute inset-0 bg-black/50"
						onClick={onMobileClose}
					/>
					<aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl dark:bg-zinc-900">
						<button
							type="button"
							aria-label="Close menu"
							onClick={onMobileClose}
							className="absolute right-3 top-4 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
						>
							<XIcon size={18} />
						</button>
						<SidebarContent
							accountName={accountName}
							route={route}
							onNavigate={(r) => {
								onNavigate(r);
								onMobileClose();
							}}
							onDisconnect={onDisconnect}
						/>
					</aside>
				</div>
			)}
		</>
	);
}

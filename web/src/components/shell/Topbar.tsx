import { MenuIcon, MoonIcon, RefreshIcon, SunIcon } from "../Icons";

interface TopbarProps {
	title: string;
	theme: "dark" | "light";
	onToggleTheme: () => void;
	onSync: () => void;
	syncing: boolean;
	showSync?: boolean;
	onMobileMenu: () => void;
}

export function Topbar({ title, theme, onToggleTheme, onSync, syncing, showSync = true, onMobileMenu }: TopbarProps) {
	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 md:px-6 dark:border-zinc-800 dark:bg-zinc-900">
			<button
				type="button"
				aria-label="Open menu"
				onClick={onMobileMenu}
				className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800"
			>
				<MenuIcon size={20} />
			</button>

			<h1 className="flex-1 truncate text-base font-semibold">{title}</h1>

			{showSync && (
				<button
					type="button"
					onClick={onSync}
					disabled={syncing}
					className="flex items-center gap-2 rounded-lg bg-cf px-3 py-1.5 text-sm font-medium text-white transition hover:bg-cf-hover disabled:opacity-50"
				>
					<RefreshIcon size={15} className={syncing ? "animate-spin" : undefined} />
					<span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
				</button>
			)}

			<button
				type="button"
				onClick={onToggleTheme}
				aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
				className="rounded-lg border border-zinc-200 p-2 text-zinc-500 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
			>
				{theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
			</button>
		</header>
	);
}

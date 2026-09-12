import type { CfZone } from "../../types";
import { TIME_PRESETS, type TimePresetKey } from "../../hooks/useTimeRange";
import type { SessionMode } from "../../hooks/useSession";
import { LogoutIcon, MenuIcon, MoonIcon, RefreshIcon, SunIcon } from "../Icons";
import { BTN_ICON, BTN_PRIMARY, FOCUS_RING, SELECT } from "../../lib/ui";

export interface ZonePickerProps {
	zones: CfZone[];
	value: string;
	onChange: (zoneId: string) => void;
	loading: boolean;
	// WAF can run account-wide; Cache requires a concrete zone
	accountWideLabel?: string;
}

export interface RangePickerProps {
	value: TimePresetKey;
	onChange: (next: TimePresetKey) => void;
}

interface TopbarProps {
	title: string;
	theme: "dark" | "light";
	onToggleTheme: () => void;
	/** Absent while no section has registered a reload — the button is hidden then anyway. */
	onSync?: () => void;
	syncing: boolean;
	showSync?: boolean;
	zonePicker?: ZonePickerProps;
	/** Shared analytics window. Absent on sections that are not time-windowed. */
	rangePicker?: RangePickerProps;
	onDisconnect: () => void;
	mode: SessionMode;
	onMobileMenu: () => void;
}

export function Topbar({ title, theme, onToggleTheme, onSync, syncing, showSync = true, zonePicker, rangePicker, onDisconnect, mode, onMobileMenu }: TopbarProps) {
	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 md:px-6 dark:border-zinc-800 dark:bg-zinc-900">
			<button
				type="button"
				aria-label="Open menu"
				onClick={onMobileMenu}
				className={`rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800 ${FOCUS_RING}`}
			>
				<MenuIcon size={20} />
			</button>

			<h1 className="flex-1 truncate text-base font-semibold">{title}</h1>

			{rangePicker && (
				<select
					value={rangePicker.value}
					onChange={(e) => rangePicker.onChange(e.target.value as TimePresetKey)}
					aria-label="Time range"
					className={SELECT}
				>
					{TIME_PRESETS.map((preset) => (
						<option key={preset.key} value={preset.key}>{preset.label}</option>
					))}
				</select>
			)}

			{zonePicker && (
				<select
					value={zonePicker.value}
					onChange={(e) => zonePicker.onChange(e.target.value)}
					disabled={zonePicker.loading}
					aria-label="Select zone"
					className={`max-w-52 ${SELECT}`}
				>
					<option value="">
						{zonePicker.loading ? "Loading zones…" : zonePicker.accountWideLabel || "Select zone…"}
					</option>
					{zonePicker.zones.map((z) => (
						<option key={z.id} value={z.id}>{z.name || z.id}</option>
					))}
				</select>
			)}

			{showSync && (
				<button
					type="button"
					onClick={onSync}
					disabled={syncing}
					className={BTN_PRIMARY}
				>
					<RefreshIcon size={15} className={syncing ? "animate-spin" : undefined} />
					<span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
				</button>
			)}

			<button
				type="button"
				onClick={onToggleTheme}
				aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
				className={BTN_ICON}
			>
				{theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
			</button>

			{/* In BYOT mode this is the only control that clears the pasted token, so it cannot
			    live only in the sidebar. In server mode the browser holds no credential, so the
			    equivalent act is ending the Cloudflare Access session. */}
			<button
				type="button"
				onClick={() => {
					onDisconnect();
					if (mode === "server") {
						window.location.href = "/cdn-cgi/access/logout";
					}
				}}
				aria-label={mode === "server" ? "Sign out" : "Disconnect and clear token"}
				title={mode === "server" ? "Sign out" : "Disconnect and clear token"}
				className={`rounded-lg border border-zinc-200 p-2 text-zinc-500 transition hover:border-red-300/50 hover:bg-red-500/10 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-500/30 dark:hover:text-red-400 ${FOCUS_RING}`}
			>
				<LogoutIcon size={16} />
			</button>
		</header>
	);
}

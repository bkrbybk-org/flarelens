import { AUTO_REFRESH_OPTIONS } from "../../hooks/usePresentation";
import { MinimizeIcon, RefreshIcon } from "../Icons";
import { FOCUS_RING, MUTED } from "../../lib/ui";

/**
 * The only chrome left in presentation mode: what the screen shows (page, account, window) and
 * when it was last read, so a passer-by knows how current it is. The controls stay out of the way
 * — faint until the pointer or keyboard reaches the bar — so they do not compete with the data
 * on a booth screen.
 */
export function PresentationBar({
	title,
	accountName,
	windowLabel,
	updatedAt,
	refreshing,
	autoRefreshMs,
	onAutoRefresh,
	onRefresh,
	onExit,
}: {
	title: string;
	accountName: string;
	windowLabel?: string;
	updatedAt: Date | null;
	refreshing: boolean;
	autoRefreshMs: number;
	onAutoRefresh: (ms: number) => void;
	onRefresh?: () => void;
	onExit: () => void;
}) {
	return (
		<header className="group flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
			<h1 className="text-xl font-semibold">{title}</h1>
			<span className={`text-sm ${MUTED}`}>
				{accountName}
				{windowLabel ? ` · ${windowLabel}` : ""}
			</span>
			<span className={`text-xs ${MUTED}`} aria-live="polite">
				{refreshing ? "Updating…" : updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
			</span>
			<div className="ml-auto flex items-center gap-2 opacity-25 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				<label className="flex items-center gap-1.5 text-xs">
					<span className={MUTED}>Auto-refresh</span>
					<select
						value={autoRefreshMs}
						onChange={(e) => onAutoRefresh(Number(e.target.value))}
						className={`rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}
					>
						{AUTO_REFRESH_OPTIONS.map((o) => (
							<option key={o.ms} value={o.ms}>{o.label}</option>
						))}
					</select>
				</label>
				{onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						disabled={refreshing}
						aria-label="Refresh now"
						title="Refresh now"
						className={`rounded-lg border border-zinc-200 p-2 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 ${FOCUS_RING}`}
					>
						<RefreshIcon size={16} className={refreshing ? "animate-spin" : undefined} />
					</button>
				)}
				<button
					type="button"
					onClick={onExit}
					className={`flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`}
				>
					<MinimizeIcon size={14} />
					Exit full screen <kbd className="font-mono text-[10px] text-zinc-400">Esc</kbd>
				</button>
			</div>
		</header>
	);
}

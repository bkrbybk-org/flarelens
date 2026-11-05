import { useState } from "react";
import { AUTO_REFRESH_OPTIONS, TEXT_SCALE_OPTIONS } from "../../hooks/usePresentation";
import { ROTATION_INTERVALS, type RotationConfig } from "../../hooks/usePageRotation";
import type { Route } from "../../hooks/useRoute";
import { MinimizeIcon, RefreshIcon } from "../Icons";
import { BTN_PRIMARY, FOCUS_RING, MUTED } from "../../lib/ui";
import { NAV_GROUPS } from "./nav";

export interface RotationControls {
	config: RotationConfig;
	running: boolean;
	paused: boolean;
	next: Route | null;
	secondsLeft: number;
	/** 1-based place of the current page in the loop, or 0 when it is not in it. */
	position: number;
	onStart: (config: RotationConfig) => void;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
}

const LABEL = new Map(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.route, i.label] as const)));
const CONTROL = `rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`;
const SMALL_BTN = `rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`;

function formatLeft(seconds: number): string {
	return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

/** Which pages to loop through, and how long on each. */
function RotationSettings({ initial, onStart, onClose }: { initial: RotationConfig; onStart: (config: RotationConfig) => void; onClose: () => void }) {
	const [chosen, setChosen] = useState<Route[]>(initial.routes);
	const [intervalMs, setIntervalMs] = useState(initial.intervalMs);
	const toggle = (route: Route, on: boolean) =>
		// Kept in sidebar order whatever order they were ticked in: the loop reads like the menu.
		setChosen((prev) => {
			const set = new Set(prev);
			if (on) set.add(route);
			else set.delete(route);
			return NAV_GROUPS.flatMap((g) => g.items.map((i) => i.route)).filter((r) => set.has(r));
		});
	return (
		<div role="dialog" aria-label="Page rotation" className="absolute right-6 top-full z-40 mt-2 w-[min(40rem,calc(100vw-3rem))] rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
			<h2 className="mb-1 text-sm font-semibold">Rotate pages</h2>
			<p className={`mb-3 text-xs ${MUTED}`}>
				Pick two or more pages; the screen moves to the next one after each interval. Clicking around restarts the countdown.
			</p>
			<div className="grid max-h-72 gap-3 overflow-auto sm:grid-cols-2">
				{NAV_GROUPS.map((group) => (
					<fieldset key={group.label}>
						<legend className={`mb-1 text-xs font-medium uppercase tracking-wide ${MUTED}`}>{group.label}</legend>
						{group.items.map((item) => (
							<label key={item.route} className="flex items-center gap-2 py-0.5 text-sm">
								<input type="checkbox" checked={chosen.includes(item.route)} onChange={(e) => toggle(item.route, e.target.checked)} />
								{item.label}
							</label>
						))}
					</fieldset>
				))}
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-1.5 text-xs">
					<span className={MUTED}>Each page for</span>
					<select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} className={CONTROL}>
						{ROTATION_INTERVALS.map((i) => (
							<option key={i.ms} value={i.ms}>{i.label}</option>
						))}
					</select>
				</label>
				<span className={`text-xs ${MUTED}`}>{chosen.length} selected</span>
				<div className="ml-auto flex gap-2">
					<button type="button" onClick={onClose} className={SMALL_BTN}>Cancel</button>
					<button type="button" disabled={chosen.length < 2} onClick={() => onStart({ routes: chosen, intervalMs })} className={BTN_PRIMARY}>
						Start rotation
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * The only chrome left in presentation mode: what the screen shows (page, account, window) and
 * when it was last read, so a passer-by knows how current it is. The controls stay out of the way
 * — faint until the pointer or keyboard reaches the bar — so they do not compete with the data
 * on a booth screen. A running rotation shows where it is in the loop and what comes next.
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
	rotation,
	textScale,
	onTextScale,
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
	rotation?: RotationControls;
	/** Root text size while presenting, in percent; the picker shows only when both are given. */
	textScale?: number;
	onTextScale?: (pct: number) => void;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const running = rotation?.running && rotation.next;
	return (
		<header className="group relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
			<h1 className="text-xl font-semibold">{title}</h1>
			<span className={`text-sm ${MUTED}`}>
				{accountName}
				{windowLabel ? ` · ${windowLabel}` : ""}
			</span>
			<span className={`text-xs ${MUTED}`} aria-live="polite">
				{refreshing ? "Updating…" : updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
			</span>
			{running && rotation && (
				<span className="text-xs" role="status">
					<span className={MUTED}>
						Rotating {rotation.position ? `${rotation.position}/${rotation.config.routes.length}` : ""} · next:{" "}
					</span>
					<span className="font-medium">{LABEL.get(rotation.next!) ?? rotation.next}</span>
					<span className={MUTED}> {rotation.paused ? "· paused" : `in ${formatLeft(rotation.secondsLeft)}`}</span>
				</span>
			)}
			<div
				className={`ml-auto flex flex-wrap items-center gap-2 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${settingsOpen ? "opacity-100" : "opacity-25"}`}
			>
				{rotation &&
					(running ? (
						<>
							<button type="button" onClick={rotation.paused ? rotation.onResume : rotation.onPause} className={SMALL_BTN}>
								{rotation.paused ? "Resume" : "Pause"}
							</button>
							<button type="button" onClick={rotation.onStop} className={SMALL_BTN}>
								Stop rotation
							</button>
						</>
					) : (
						<button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)} className={SMALL_BTN}>
							Rotate pages…
						</button>
					))}
				{textScale !== undefined && onTextScale && (
					<label className="flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Text size</span>
						<select value={textScale} onChange={(e) => onTextScale(Number(e.target.value))} className={CONTROL}>
							{TEXT_SCALE_OPTIONS.map((o) => (
								<option key={o.pct} value={o.pct}>{o.label}</option>
							))}
						</select>
					</label>
				)}
				<label className="flex items-center gap-1.5 text-xs">
					<span className={MUTED}>Auto-refresh</span>
					<select value={autoRefreshMs} onChange={(e) => onAutoRefresh(Number(e.target.value))} className={CONTROL}>
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
				<button type="button" onClick={onExit} className={`flex items-center gap-1.5 ${SMALL_BTN}`}>
					<MinimizeIcon size={14} />
					Exit full screen <kbd className="font-mono text-[10px] text-zinc-400">Esc</kbd>
				</button>
			</div>
			{settingsOpen && rotation && !running && (
				<RotationSettings
					initial={rotation.config}
					onClose={() => setSettingsOpen(false)}
					onStart={(config) => {
						setSettingsOpen(false);
						rotation.onStart(config);
					}}
				/>
			)}
		</header>
	);
}

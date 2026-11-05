import { useCallback, useEffect, useRef, useState } from "react";
import { storageGet, storageSet } from "../lib/storage";

/**
 * Run `refresh` every `intervalMs` (0 is off). The latest refresh and busy flag are read at each
 * tick, so a section that changes under it is refreshed as it is now; a reload still running is
 * not stacked on — the next tick catches up.
 */
export function useAutoRefresh(intervalMs: number, refresh: (() => void) | undefined, busy: boolean): void {
	const latest = useRef({ refresh, busy });
	useEffect(() => {
		latest.current = { refresh, busy };
	});
	useEffect(() => {
		if (!intervalMs) return;
		const timer = setInterval(() => {
			if (!latest.current.busy) latest.current.refresh?.();
		}, intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
}

/**
 * Presentation mode: the current page alone on the screen, for a booth or a meeting room.
 *
 * Entering asks the browser for real full screen. That can be refused (an embedded frame, a
 * browser without the API, a permissions policy), and the mode still works without it — the
 * sidebar and top bar go away, which is most of what a presenter wants. Leaving full screen by the
 * browser's own means (Esc, F11) leaves the mode too, so the two never disagree; without full
 * screen, Esc is handled here.
 */
export function usePresentation() {
	const [active, setActive] = useState(false);

	const enter = useCallback(async () => {
		setActive(true);
		try {
			if (document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
		} catch {
			// Refused: present inside the window instead.
		}
	}, []);

	const exit = useCallback(() => {
		setActive(false);
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	}, []);

	useEffect(() => {
		const onChange = () => {
			if (!document.fullscreenElement) setActive(false);
		};
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.fullscreenElement) setActive(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);

	return { active, enter, exit };
}

/** Text sizes for a screen read from across a room, as a percentage of the normal root size. */
export const TEXT_SCALE_OPTIONS = [
	{ pct: 100, label: "Normal" },
	{ pct: 125, label: "Large" },
	{ pct: 150, label: "Extra large" },
] as const;
const TEXT_SCALE_KEY = "flarelens_present_text";
const DEFAULT_TEXT_SCALE = 125;

function loadTextScale(): number {
	const saved = Number(storageGet("local", TEXT_SCALE_KEY));
	return TEXT_SCALE_OPTIONS.some((o) => o.pct === saved) ? saved : DEFAULT_TEXT_SCALE;
}

/**
 * Larger text while presenting. Sizes and spacing are in rem throughout, so raising the root font
 * size scales the page as a whole, like browser zoom, without touching any page. Only while the
 * mode is on; leaving it puts the normal size back. The choice is remembered per browser.
 */
export function usePresentationTextScale(active: boolean) {
	const [scale, setScale] = useState(loadTextScale);
	useEffect(() => {
		if (!active || scale === 100) return;
		const root = document.documentElement;
		root.style.fontSize = `${scale}%`;
		return () => {
			root.style.fontSize = "";
		};
	}, [active, scale]);
	const choose = useCallback((pct: number) => {
		setScale(pct);
		storageSet("local", TEXT_SCALE_KEY, String(pct));
	}, []);
	return [scale, choose] as const;
}

/** Auto-refresh choices for an unattended screen, in milliseconds; 0 is off. */
export const AUTO_REFRESH_OPTIONS = [
	{ ms: 0, label: "Off" },
	{ ms: 60_000, label: "Every minute" },
	{ ms: 300_000, label: "Every 5 minutes" },
	{ ms: 900_000, label: "Every 15 minutes" },
] as const;

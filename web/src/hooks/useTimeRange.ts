import { useCallback } from "react";
import { useHashSyncedState } from "./useHashParams";
import type { Prefs } from "./usePrefs";

/**
 * One time range for every analytics section.
 *
 * Each section used to own its own picker with its own vocabulary — WAF in lookback minutes,
 * Cache in a fixed set of hours, the newer sections in preset keys — so switching sections
 * silently switched the window you were looking at. This is the single source of truth; a
 * section still clamps it to whatever its upstream dataset actually allows.
 *
 * Stored in minutes rather than a preset key so clamping is arithmetic rather than a lookup
 * table, and so a section can honour a range that is not one of the presets.
 */
export const TIME_PRESETS = [
	{ key: "1h", label: "Last hour", minutes: 60 },
	{ key: "6h", label: "Last 6 hours", minutes: 360 },
	{ key: "24h", label: "Last 24 hours", minutes: 1440 },
	{ key: "7d", label: "Last 7 days", minutes: 10_080 },
	{ key: "30d", label: "Last 30 days", minutes: 43_200 },
] as const;

export type TimePresetKey = (typeof TIME_PRESETS)[number]["key"];

export const DEFAULT_RANGE_MINUTES = 1440;

export function presetForMinutes(minutes: number): TimePresetKey {
	const match = TIME_PRESETS.find((p) => p.minutes === minutes);
	return match ? match.key : "24h";
}

function minutesForPreset(key: string): number | null {
	return TIME_PRESETS.find((p) => p.key === key)?.minutes ?? null;
}

export interface TimeRange {
	/** The selected window, in minutes. */
	minutes: number;
	preset: TimePresetKey;
	setPreset: (key: TimePresetKey) => void;
	/**
	 * The window a section will actually query, clamped to its upstream limit, plus whether
	 * clamping happened so the page can say so rather than silently showing a shorter window.
	 */
	clamp: (maxMinutes: number) => { minutes: number; clamped: boolean };
	/** Absolute bounds for the clamped window, as the ISO instants the API requires. */
	bounds: (maxMinutes?: number) => { from: string; to: string };
}

export function useTimeRange(prefs: Prefs, updatePrefs: (patch: Partial<Prefs>) => void, route: string): TimeRange {
	const minutes = prefs.rangeMinutes || DEFAULT_RANGE_MINUTES;
	const preset = presetForMinutes(minutes);

	// Deep-linkable: `#/workers?range=7d` selects the window, and changing the window updates
	// the URL, so a section view can be shared as-is. `route` is threaded through so a
	// hand-edited cross-route link (this hook lives in App and never remounts) still adopts.
	useHashSyncedState(
		"range",
		preset,
		(next) => {
			const fromHash = minutesForPreset(next);
			if (fromHash !== null && fromHash !== minutes) {
				updatePrefs({ rangeMinutes: fromHash });
			}
		},
		route,
	);

	const setPreset = useCallback(
		(key: TimePresetKey) => {
			const next = minutesForPreset(key);
			if (next !== null) updatePrefs({ rangeMinutes: next });
		},
		[updatePrefs],
	);

	const clamp = useCallback(
		(maxMinutes: number) => ({ minutes: Math.min(minutes, maxMinutes), clamped: minutes > maxMinutes }),
		[minutes],
	);

	const bounds = useCallback(
		(maxMinutes?: number) => {
			const span = maxMinutes ? Math.min(minutes, maxMinutes) : minutes;
			const to = new Date();
			// Whole minutes: the bounds land in GraphQL documents, and a stable value keeps
			// repeated renders from producing a different window each time.
			to.setSeconds(0, 0);
			return { from: new Date(to.getTime() - span * 60_000).toISOString(), to: to.toISOString() };
		},
		[minutes],
	);

	return { minutes, preset, setPreset, clamp, bounds };
}

/** Sections whose data is time-windowed; the picker is hidden everywhere else. */
export const TIME_RANGE_ROUTES = new Set(["waf", "cache", "ai-security", "workers", "workers-ai", "ai-gateway", "access-usage", "gateway", "cost"]);

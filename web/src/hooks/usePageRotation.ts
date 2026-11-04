import { useEffect, useState } from "react";
import { ROUTES, type Route } from "./useRoute";
import { storageGet, storageSet } from "../lib/storage";

/**
 * Page rotation for presentation mode: an unattended booth screen moves through a chosen list of
 * pages, one interval each.
 *
 * The countdown restarts whenever the page changes, by rotation or by hand, so someone stepping
 * up and clicking around gets the full interval on the page they picked. Each page remounts on
 * arrival and so reads fresh data — the configuration routes from a 60-second edge cache.
 *
 * The list and interval are a per-viewer convenience, kept in localStorage through
 * lib/storage.ts (which never throws): a booth laptop remembers its loop across reloads.
 */

export const ROTATION_INTERVALS = [
	{ ms: 30_000, label: "30 seconds" },
	{ ms: 60_000, label: "1 minute" },
	{ ms: 120_000, label: "2 minutes" },
	{ ms: 300_000, label: "5 minutes" },
] as const;

export interface RotationConfig {
	routes: Route[];
	intervalMs: number;
}

const KEY = "flarelens_rotation";
const DEFAULT: RotationConfig = { routes: [], intervalMs: 60_000 };

export function loadRotation(): RotationConfig {
	try {
		const parsed = JSON.parse(storageGet("local", KEY) ?? "null") as Partial<RotationConfig> | null;
		if (!parsed || typeof parsed !== "object") return DEFAULT;
		const routes = Array.isArray(parsed.routes) ? parsed.routes.filter((r): r is Route => (ROUTES as string[]).includes(r as string)) : [];
		const intervalMs = ROTATION_INTERVALS.some((i) => i.ms === parsed.intervalMs) ? (parsed.intervalMs as number) : DEFAULT.intervalMs;
		return { routes: [...new Set(routes)], intervalMs };
	} catch {
		return DEFAULT;
	}
}

export function saveRotation(config: RotationConfig): void {
	storageSet("local", KEY, JSON.stringify(config));
}

/** The page after `current` in the loop; the first one when `current` is not in it. Null for fewer than two pages. */
export function nextRoute(routes: Route[], current: Route): Route | null {
	if (routes.length < 2) return null;
	const at = routes.indexOf(current);
	return routes[(at + 1) % routes.length];
}

/** Seconds until the next page, and which page that is. Counts only while running and not paused. */
export function usePageRotation({
	running,
	paused,
	config,
	route,
	navigate,
}: {
	running: boolean;
	paused: boolean;
	config: RotationConfig;
	route: Route;
	navigate: (route: Route) => void;
}): { next: Route | null; secondsLeft: number } {
	const next = running ? nextRoute(config.routes, route) : null;
	const key = next ? `${route}|${config.intervalMs}|${config.routes.join(",")}` : "";
	const [state, setState] = useState({ key, elapsed: 0 });
	// A new page, interval or list restarts the countdown. Adjusted while rendering rather than in
	// an effect, so the bar never shows a stale count for a frame.
	if (state.key !== key) setState({ key, elapsed: 0 });

	const ticking = Boolean(next) && !paused;
	useEffect(() => {
		if (!ticking) return;
		const timer = setInterval(() => setState((s) => ({ ...s, elapsed: s.elapsed + 1 })), 1000);
		return () => clearInterval(timer);
	}, [ticking]);

	const secondsLeft = Math.max(0, Math.round(config.intervalMs / 1000) - state.elapsed);
	useEffect(() => {
		if (next && !paused && secondsLeft === 0) navigate(next);
	}, [next, paused, secondsLeft, navigate]);

	return { next, secondsLeft };
}

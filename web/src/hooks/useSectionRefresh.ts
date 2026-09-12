import { createContext, useContext, useEffect } from "react";

/**
 * One refresh control for every section.
 *
 * The app had two. Three sections reloaded from a "Sync" button in the top bar; the other eleven
 * each drew their own "Refresh" inside the page, in one of two styles. Same act, two names, two
 * places, and which one you got depended on the section — so the first thing a reader did on
 * arriving anywhere new was hunt for the control.
 *
 * The top bar wins because it is the one position that does not move. A section registers what
 * reloading means for it, and the bar drives that: the button knows what it is reloading without
 * App having to know how any particular section fetches.
 *
 * Registration is deliberately last-write-wins rather than a list. Exactly one section is mounted
 * at a time, and a stale registration surviving a route change would point Sync at the page the
 * reader just left — so the effect clears on unmount.
 */
export interface SectionRefresh {
	/** Must be stable across renders, or the section re-registers on every one. */
	reload: () => void;
	/** Drives the button's spinner and disabled state. */
	loading: boolean;
}

export const SectionRefreshContext = createContext<(refresh: SectionRefresh | null) => void>(() => {});

/** Call from a section to put its reload behind the top bar's Sync button. */
export function useSectionRefresh(reload: () => void, loading: boolean) {
	const register = useContext(SectionRefreshContext);
	useEffect(() => {
		register({ reload, loading });
		return () => register(null);
	}, [register, reload, loading]);
}

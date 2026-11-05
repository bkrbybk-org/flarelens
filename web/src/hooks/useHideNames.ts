import { createContext, useCallback, useContext, useState } from "react";
import { storageGet, storageSet } from "../lib/storage";

/**
 * Whether people's names are hidden on screen: on while presenting with "Hide names" ticked, so a
 * booth or a customer meeting never shows a colleague's email. Pages that show people (the AI
 * Gateway users) read it and put a stable alias — User A, User B — in place of each name.
 */
export const HideNamesContext = createContext(false);

export function useHideNames(): boolean {
	return useContext(HideNamesContext);
}

const HIDE_NAMES_KEY = "flarelens_present_hide_names";

/** The presenter's choice, kept in this browser. On unless turned off: a public screen is the safer default. */
export function useHideNamesPreference() {
	const [hide, setHide] = useState(() => storageGet("local", HIDE_NAMES_KEY) !== "0");
	const choose = useCallback((next: boolean) => {
		setHide(next);
		storageSet("local", HIDE_NAMES_KEY, next ? "1" : "0");
	}, []);
	return [hide, choose] as const;
}

/** A, B, … Z, AA, AB, …: the n-th alias letter, from 0. */
export function aliasLetters(n: number): string {
	let out = "";
	let i = n;
	do {
		out = String.fromCharCode(65 + (i % 26)) + out;
		i = Math.floor(i / 26) - 1;
	} while (i >= 0);
	return out;
}

import { useCallback, useEffect, useState } from "react";

const PREFS_KEY = "cf_zt_prefs";

export interface Prefs {
	theme: "dark" | "light";
	perPage: number;
	density: "comfortable" | "compact";
	columnVisibility: Record<string, boolean>;
	columnOrder: string[];
}

const DEFAULT_PREFS: Prefs = {
	theme: "dark",
	perPage: 10,
	density: "comfortable",
	columnVisibility: {},
	columnOrder: [],
};

function readPrefs(): Prefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (!raw) {
			return DEFAULT_PREFS;
		}
		return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
	} catch {
		return DEFAULT_PREFS;
	}
}

export function usePrefs() {
	const [prefs, setPrefs] = useState<Prefs>(readPrefs);

	useEffect(() => {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	}, [prefs]);

	useEffect(() => {
		document.documentElement.classList.toggle("dark", prefs.theme === "dark");
	}, [prefs.theme]);

	const updatePrefs = useCallback((patch: Partial<Prefs>) => {
		setPrefs((prev) => ({ ...prev, ...patch }));
	}, []);

	return { prefs, updatePrefs };
}

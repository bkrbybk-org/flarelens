import { useCallback, useEffect, useState } from "react";

const PREFS_KEY = "cf_zt_prefs";
// Bump when column defaults change shape: stale saved order/visibility is
// dropped so new defaults apply, while theme/density/perPage survive.
const PREFS_VERSION = 2;

export interface Prefs {
	version: number;
	theme: "dark" | "light";
	perPage: number;
	density: "comfortable" | "compact";
	columnVisibility: Record<string, boolean>;
	columnOrder: string[];
	// Zone selection per zone-scoped feature ("" = account-wide for WAF, unselected for Cache)
	wafZone: string;
	cacheZone: string;
}

const DEFAULT_PREFS: Prefs = {
	version: PREFS_VERSION,
	theme: "dark",
	perPage: 10,
	density: "comfortable",
	columnVisibility: {},
	columnOrder: [],
	wafZone: "",
	cacheZone: "",
};

function readPrefs(): Prefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (!raw) {
			return DEFAULT_PREFS;
		}
		const parsed = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
		if (parsed.version !== PREFS_VERSION) {
			return { ...parsed, version: PREFS_VERSION, columnVisibility: {}, columnOrder: [] };
		}
		return parsed;
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

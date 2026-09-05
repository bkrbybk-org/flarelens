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
	/** Zone scope for the AI Security section; empty means every zone the token can see. */
	aiSecZone: string;
	/** Sidebar collapsed to icons only. Persisted: it is a workspace preference, not view state. */
	sidebarCollapsed: boolean;
	/** Shared analytics window in minutes; see hooks/useTimeRange.ts. */
	rangeMinutes: number;
	/**
	 * Unit rates for the Cost & Usage section, entered by the operator. Deliberately not
	 * seeded with Cloudflare list prices: they change, they differ per contract, and a wrong
	 * number presented as an estimate is worse than no number.
	 */
	costRates: { requestsPerMillion: number; subrequestsPerMillion: number; neuron: number };
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
	aiSecZone: "",
	sidebarCollapsed: false,
	rangeMinutes: 1440,
	costRates: { requestsPerMillion: 0, subrequestsPerMillion: 0, neuron: 0 },
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

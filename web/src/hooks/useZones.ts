import { useCallback, useRef, useState } from "react";
import { fetchZones } from "../api/client";
import type { CfZone } from "../types";

// Zones for the current account, fetched lazily the first time a
// zone-scoped feature (WAF, Cache) needs them.
export function useZones() {
	const [zones, setZones] = useState<CfZone[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Not rendered anywhere today (zones has no caption per the UI spec), but kept alongside the
	// other two edge-cached fetchers so the hook's shape matches useTunnelMap/usePqcReport.
	const [cachedAt, setCachedAt] = useState<string | null>(null);
	const loadedForRef = useRef<string | null>(null);
	const inFlightRef = useRef(false);

	const ensureLoaded = useCallback(async (token: string, accountId: string) => {
		if (loadedForRef.current === accountId || inFlightRef.current) {
			return;
		}
		inFlightRef.current = true;
		setLoading(true);
		setError(null);
		try {
			const { result, cachedAt: at } = await fetchZones(token, accountId);
			result.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
			setZones(result);
			setCachedAt(at);
			loadedForRef.current = accountId;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch zones");
		} finally {
			inFlightRef.current = false;
			setLoading(false);
		}
	}, []);

	const reset = useCallback(() => {
		setZones([]);
		setError(null);
		setCachedAt(null);
		loadedForRef.current = null;
	}, []);

	return { zones, loading, error, cachedAt, ensureLoaded, reset };
}

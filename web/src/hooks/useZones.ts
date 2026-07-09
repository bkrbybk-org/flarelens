import { useCallback, useRef, useState } from "react";
import { fetchZones } from "../api/client";
import type { CfZone } from "../types";

// Zones for the current account, fetched lazily the first time a
// zone-scoped feature (WAF, Cache) needs them.
export function useZones() {
	const [zones, setZones] = useState<CfZone[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const loadedForRef = useRef<string | null>(null);

	const ensureLoaded = useCallback(async (token: string, accountId: string) => {
		if (loadedForRef.current === accountId || loading) {
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const result = await fetchZones(token, accountId);
			result.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
			setZones(result);
			loadedForRef.current = accountId;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch zones");
		} finally {
			setLoading(false);
		}
	}, [loading]);

	const reset = useCallback(() => {
		setZones([]);
		setError(null);
		loadedForRef.current = null;
	}, []);

	return { zones, loading, error, ensureLoaded, reset };
}

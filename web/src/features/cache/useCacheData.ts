import { useCallback, useRef, useState } from "react";
import { ApiError, fetchCacheAnalysis } from "../../api/client";
import type { CacheAnalysis } from "./types";

interface CacheState {
	data: CacheAnalysis | null;
	loading: boolean;
	error: string | null;
}

export function useCacheData(onAuthError: () => void) {
	const [state, setState] = useState<CacheState>({ data: null, loading: false, error: null });
	const requestIdRef = useRef(0);

	const load = useCallback(async (token: string, zoneId: string, rangeHours: number) => {
		const requestId = ++requestIdRef.current;
		setState((prev) => ({ ...prev, loading: true, error: null }));
		try {
			const data = await fetchCacheAnalysis<CacheAnalysis>(token, zoneId, rangeHours);
			if (requestId !== requestIdRef.current) return;
			setState({ data, loading: false, error: null });
		} catch (err) {
			if (requestId !== requestIdRef.current) return;
			if (err instanceof ApiError && err.status === 401) {
				onAuthError();
				return;
			}
			setState((prev) => ({
				...prev,
				loading: false,
				error: err instanceof Error ? err.message : "Failed to analyze cache rules",
			}));
		}
	}, [onAuthError]);

	return { ...state, load };
}

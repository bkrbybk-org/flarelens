import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchCacheAnalysis } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { CacheAnalysis } from "./types";

interface CacheState {
	data: CacheAnalysis | null;
	loading: boolean;
	error: string | null;
}

export function useCacheData(onAuthError: () => void) {
	const [state, setState] = useState<CacheState>({ data: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_cache_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(async (token: string, zoneId: string, rangeHours: number) => {
		const requestId = ++requestIdRef.current;
		setState((prev) => ({ ...prev, loading: true, error: null }));
		progressStart();
		let success = false;
		try {
			const data = await fetchCacheAnalysis<CacheAnalysis>(token, zoneId, rangeHours);
			if (requestId !== requestIdRef.current) return;
			success = true;
			setState({ data, loading: false, error: null });
		} catch (err) {
			if (requestId !== requestIdRef.current) return;
			if (err instanceof ApiError && err.status === 401) {
				onAuthErrorRef.current();
				return;
			}
			setState((prev) => ({
				...prev,
				loading: false,
				error: err instanceof Error ? err.message : "Failed to analyze cache rules",
			}));
		} finally {
			progressStop(success);
		}
	}, [progressStart, progressStop]);

	return { ...state, load, progress };
}

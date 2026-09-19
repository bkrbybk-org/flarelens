import { useCallback, useEffect, useRef, useState } from "react";
import {fetchAccessUsage, isSessionError } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { AccessGranularity, AccessUsageResult } from "./types";

interface State {
	result: AccessUsageResult | null;
	loading: boolean;
	error: string | null;
}

export function useAccessUsage(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_access_usage_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, from: string, to: string, granularity: AccessGranularity) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const result = await fetchAccessUsage<AccessUsageResult>(token, { accountId, from, to, granularity });
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, loading: false, error: null });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (isSessionError(err)) {
					onAuthErrorRef.current();
					return;
				}
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to load Access usage",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

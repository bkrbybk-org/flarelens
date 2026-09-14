import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchZoneHealthReport } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { ZoneHealthResult } from "./types";

interface State {
	result: ZoneHealthResult | null;
	loading: boolean;
	error: string | null;
}

/** Same loader shape as usePqcReport: request-id guard, 401/403 escalated to a disconnect. */
export function useZoneHealthReport(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_zone_health_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const result = await fetchZoneHealthReport<ZoneHealthResult>(token, accountId);
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, loading: false, error: null });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
					onAuthErrorRef.current();
					return;
				}
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to build the Zone Health report",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

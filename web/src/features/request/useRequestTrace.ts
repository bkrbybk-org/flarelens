import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, traceRequest } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { RequestTraceResult } from "./types";

interface State {
	result: RequestTraceResult | null;
	loading: boolean;
	error: string | null;
}

export function useRequestTrace(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_request_trace_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, rayId: string, zoneId: string, minutes: number) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const result = await traceRequest<RequestTraceResult>(token, {
					accountId,
					rayId,
					zoneId: zoneId || undefined,
					minutes,
				});
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
					error: err instanceof Error ? err.message : "Failed to trace the request",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load, reset: () => setState({ result: null, loading: false, error: null }) };
}

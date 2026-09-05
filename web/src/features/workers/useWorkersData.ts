import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchWorkerMetrics, fetchWorkerScripts } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { Granularity, WorkerMetricsResult } from "./types";

interface WorkersState {
	result: WorkerMetricsResult | null;
	/** Every script on the account, including ones with no traffic in the window. */
	scripts: string[];
	loading: boolean;
	error: string | null;
}

export function useWorkersData(onAuthError: () => void) {
	const [state, setState] = useState<WorkersState>({ result: null, scripts: [], loading: false, error: null });
	const progress = useEstimatedProgress("cf_workers_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, from: string, to: string, granularity: Granularity) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				// The script list is a nice-to-have: it adds workers that had no traffic in the
				// window. It needs its own token scope, so a failure there must not lose the
				// metrics — the worker names in the data are enough to render everything.
				const [result, scripts] = await Promise.all([
					fetchWorkerMetrics<WorkerMetricsResult>(token, { accountId, from, to, granularity }),
					fetchWorkerScripts(token, accountId).catch(() => [] as string[]),
				]);
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, scripts, loading: false, error: null });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
					onAuthErrorRef.current();
					return;
				}
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to load Workers metrics",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

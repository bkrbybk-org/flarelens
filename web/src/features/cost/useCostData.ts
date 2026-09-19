import { useCallback, useEffect, useRef, useState } from "react";
import {fetchWorkerMetrics, fetchWorkersAiUsage, isSessionError } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { WorkerMetricsResult } from "../workers/types";
import type { WorkersAiResult } from "../workers-ai/types";

interface State {
	workers: WorkerMetricsResult | null;
	ai: WorkersAiResult | null;
	loading: boolean;
	error: string | null;
}

/**
 * Both halves of the rollup come from endpoints the app already has, so this page adds no new
 * Worker route — it fans out to the two existing ones and does the arithmetic in the browser.
 */
export function useCostData(onAuthError: () => void) {
	const [state, setState] = useState<State>({ workers: null, ai: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_cost_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, from: string, to: string, granularity: string) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const [workers, ai] = await Promise.all([
					fetchWorkerMetrics<WorkerMetricsResult>(token, { accountId, from, to, granularity }),
					fetchWorkersAiUsage<WorkersAiResult>(token, { accountId, from, to, granularity }),
				]);
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ workers, ai, loading: false, error: null });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (isSessionError(err)) {
					onAuthErrorRef.current();
					return;
				}
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to load usage",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

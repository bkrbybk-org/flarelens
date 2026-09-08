import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchAiGatewayUsage } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { AiGatewayGranularity, AiGatewayUsageResult } from "./types";

interface State {
	result: AiGatewayUsageResult | null;
	loading: boolean;
	error: string | null;
}

export function useAiGatewayUsage(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_ai_gateway_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, from: string, to: string, granularity: AiGatewayGranularity) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const result = await fetchAiGatewayUsage<AiGatewayUsageResult>(token, { accountId, from, to, granularity });
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
					error: err instanceof Error ? err.message : "Failed to load AI Gateway usage",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchAiSecurity } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { AiSecResult } from "../../lib/ai-sec/types";

interface AiSecState {
	result: AiSecResult | null;
	loading: boolean;
	error: string | null;
	loaded: boolean;
}

const INITIAL: AiSecState = { result: null, loading: false, error: null, loaded: false };

/**
 * Loader for the AI Security section, following the shape useWafData already established:
 * a request-id guard against out-of-order responses, 401/403 escalated to a disconnect rather
 * than shown as an error banner, and the shared estimated-progress bar keyed to this feature.
 */
export function useAiSecurityData(onAuthError: () => void) {
	const [state, setState] = useState<AiSecState>(INITIAL);
	const progress = useEstimatedProgress("cf_ai_sec_last_load_ms");
	// Changing zone and window in quick succession can land responses out of order; only the
	// newest request is allowed to write state.
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, zoneId: string, range: string) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const result = await fetchAiSecurity<AiSecResult>(token, {
					accountId,
					zoneId: zoneId || undefined,
					range,
					// The previous period is always fetched: it costs nothing extra server-side (the
					// aggregation computes it from the same rows) and it is what the KPI deltas read.
					compare: true,
				});
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, loading: false, error: null, loaded: true });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
					onAuthErrorRef.current();
					return;
				}
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to load AI Security telemetry",
				}));
			} finally {
				progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

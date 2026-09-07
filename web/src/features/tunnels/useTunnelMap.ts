import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchTunnelMap } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { TunnelMapResult } from "./types";

interface State {
	result: TunnelMapResult | null;
	loading: boolean;
	error: string | null;
}

export function useTunnelMap(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null });
	const progress = useEstimatedProgress("cf_tunnel_map_last_load_ms");
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
				const result = await fetchTunnelMap<TunnelMapResult>(token, accountId);
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
					error: err instanceof Error ? err.message : "Failed to build the tunnel map",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

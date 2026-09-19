import { useCallback, useEffect, useRef, useState } from "react";
import {fetchTunnelMap, isSessionError } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { TunnelMapResult } from "./types";

interface State {
	result: TunnelMapResult | null;
	loading: boolean;
	error: string | null;
	/** ISO timestamp of the served entry, or null when the response was live. */
	cachedAt: string | null;
}

export function useTunnelMap(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null, cachedAt: null });
	const progress = useEstimatedProgress("cf_tunnel_map_last_load_ms");
	const requestIdRef = useRef(0);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const { start: progressStart, stop: progressStop } = progress;

	const load = useCallback(
		async (token: string, accountId: string, fresh?: boolean) => {
			const requestId = ++requestIdRef.current;
			setState((prev) => ({ ...prev, loading: true, error: null }));
			progressStart();
			let success = false;
			try {
				const { result, cachedAt } = await fetchTunnelMap<TunnelMapResult>(token, accountId, { fresh });
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, loading: false, error: null, cachedAt });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (isSessionError(err)) {
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

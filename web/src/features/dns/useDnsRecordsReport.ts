import { useCallback, useEffect, useRef, useState } from "react";
import {fetchDnsRecords, isSessionError } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { DnsRecordsResult } from "./types";

interface State {
	result: DnsRecordsResult | null;
	loading: boolean;
	error: string | null;
	/** ISO time the served entry was cached, or null when the response was live. */
	cachedAt: string | null;
}

/** Same loader shape as useZoneHealthReport: request-id guard, 401/403 escalated to a disconnect. */
export function useDnsRecordsReport(onAuthError: () => void) {
	const [state, setState] = useState<State>({ result: null, loading: false, error: null, cachedAt: null });
	const progress = useEstimatedProgress("cf_dns_records_last_load_ms");
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
				const { result, cachedAt } = await fetchDnsRecords<DnsRecordsResult>(token, accountId, { fresh });
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
					error: err instanceof Error ? err.message : "Failed to build the DNS Records report",
				}));
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load };
}

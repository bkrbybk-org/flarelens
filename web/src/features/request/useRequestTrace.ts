import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWafRulesets, traceRequest, isSessionError } from "../../api/client";
import { useEstimatedProgress } from "../../hooks/useEstimatedProgress";
import type { RuleMetaMap } from "../../lib/waf/types";
import type { RequestTraceResult } from "./types";

interface State {
	result: RequestTraceResult | null;
	/** The zone's and account's WAF rules, for laying the request's matches over them. */
	ruleMeta: RuleMetaMap | null;
	/** Why the rules could not be read; the request detail still shows without them. */
	rulesError: string | null;
	loading: boolean;
	error: string | null;
}

const EMPTY: State = { result: null, ruleMeta: null, rulesError: null, loading: false, error: null };

export function useRequestTrace(onAuthError: () => void) {
	const [state, setState] = useState<State>(EMPTY);
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
			setState({ ...EMPTY, loading: true });
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
				if (!result.foundIn) {
					success = true;
					setState({ ...EMPTY, result });
					return;
				}
				// The zone's rules plus the account's, which run first. Edge-cached for 60s. A token
				// without WAF read still gets the request detail, just not the rule-by-rule view.
				let ruleMeta: RuleMetaMap | null = null;
				let rulesError: string | null = null;
				try {
					ruleMeta = (await fetchWafRulesets<RuleMetaMap>(token, accountId, result.foundIn.id)).result;
				} catch (err) {
					if (isSessionError(err)) throw err;
					rulesError = err instanceof Error ? err.message : "Could not read the WAF rules";
				}
				if (requestId !== requestIdRef.current) return;
				success = true;
				setState({ result, ruleMeta, rulesError, loading: false, error: null });
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				if (isSessionError(err)) {
					onAuthErrorRef.current();
					return;
				}
				setState({ ...EMPTY, error: err instanceof Error ? err.message : "Failed to trace the request" });
			} finally {
				if (requestId === requestIdRef.current) progressStop(success);
			}
		},
		[progressStart, progressStop],
	);

	return { ...state, progress, load, reset: () => setState(EMPTY) };
}

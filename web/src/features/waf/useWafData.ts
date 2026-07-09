import { useCallback, useRef, useState } from "react";
import { ApiError, fetchWafEvents, fetchWafRulesets } from "../../api/client";
import type { FirewallEvent, RuleMetaMap, WafDiagnostics } from "../../lib/waf/types";

interface WafState {
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
	diagnostics: WafDiagnostics | null;
	window: { since: number; until: number; minutes: number } | null;
	loading: boolean;
	error: string | null;
	loaded: boolean;
}

const INITIAL: WafState = {
	events: [],
	ruleMeta: {},
	diagnostics: null,
	window: null,
	loading: false,
	error: null,
	loaded: false,
};

export function useWafData(onAuthError: () => void) {
	const [state, setState] = useState<WafState>(INITIAL);
	// Guard against out-of-order responses when scope/lookback changes quickly
	const requestIdRef = useRef(0);

	const load = useCallback(async (token: string, accountId: string, zoneId: string, minutes: number) => {
		const requestId = ++requestIdRef.current;
		setState((prev) => ({ ...prev, loading: true, error: null }));
		const until = Date.now();
		try {
			const [eventsRes, ruleMeta] = await Promise.all([
				fetchWafEvents<FirewallEvent, WafDiagnostics>(token, accountId, zoneId, minutes),
				fetchWafRulesets<RuleMetaMap>(token, accountId, zoneId),
			]);
			if (requestId !== requestIdRef.current) return;
			setState({
				events: eventsRes.events,
				ruleMeta,
				diagnostics: eventsRes.diagnostics || null,
				window: { since: until - minutes * 60 * 1000, until, minutes },
				loading: false,
				error: null,
				loaded: true,
			});
		} catch (err) {
			if (requestId !== requestIdRef.current) return;
			if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
				onAuthError();
				return;
			}
			setState((prev) => ({
				...prev,
				loading: false,
				error: err instanceof Error ? err.message : "Failed to load WAF telemetry",
			}));
		}
	}, [onAuthError]);

	return { ...state, load };
}

import { useCallback, useMemo, useState } from "react";
import { ApiError, fetchZeroTrustData } from "../api/client";
import type { ZeroTrustData } from "../types";
import { useEstimatedProgress } from "./useEstimatedProgress";

interface State {
	data: ZeroTrustData | null;
	loading: boolean;
	error: string | null;
}

export function useZeroTrustData(onAuthError: () => void) {
	const [state, setState] = useState<State>({ data: null, loading: false, error: null });
	const progress = useEstimatedProgress();

	const load = useCallback(async (token: string, accountId: string) => {
		setState((prev) => ({ ...prev, loading: true, error: null }));
		progress.start();
		let success = false;
		try {
			const data = await fetchZeroTrustData(token, accountId);
			success = true;
			setState({ data, loading: false, error: null });
		} catch (err) {
			if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
				onAuthError();
				return;
			}
			const message = err instanceof Error ? err.message : "Failed to retrieve Zero Trust data";
			setState((prev) => ({ ...prev, loading: false, error: message }));
		} finally {
			progress.stop(success);
		}
	}, [onAuthError, progress]);

	const idpMap = useMemo(() => {
		const map: Record<string, string> = {};
		for (const idp of state.data?.idps || []) {
			map[idp.id] = idp.name || idp.type || idp.id;
		}
		return map;
	}, [state.data]);

	const groupMap = useMemo(() => {
		const map: Record<string, string> = {};
		for (const group of state.data?.groups || []) {
			map[group.id] = group.name || group.id;
		}
		return map;
	}, [state.data]);

	const reusableMap = useMemo(() => {
		const map: Record<string, import("../types").CfPolicy> = {};
		for (const policy of state.data?.reusable_policies || []) {
			map[policy.id] = policy;
		}
		return map;
	}, [state.data]);

	return { ...state, load, progress, idpMap, groupMap, reusableMap };
}

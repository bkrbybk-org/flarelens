import { useCallback, useRef, useState } from "react";
import { ApiError, fetchAccessUsage } from "../../api/client";
import type { AccessUsageResult } from "../access-usage/types";

/**
 * Login counts per application, for the Applications table's activity column.
 *
 * Deliberately its own loader rather than a field on /api/data: login telemetry is a GraphQL
 * dataset behind a different permission, it is slower than the Access REST lists, and a token
 * that cannot read it must still get the applications table. So this fails on its own and the
 * column reports why, instead of the whole page failing or — worse — every application showing
 * zero logins, which reads as "nobody uses any of this".
 *
 * The window is fixed at seven days because Cloudflare caps this dataset at one week. That bound
 * is the reason the column is labelled "Logins 7d" rather than anything open-ended: absence here
 * means "not this week", never "never".
 */
export const LOGIN_WINDOW_DAYS = 7;

interface State {
	/** app uuid → successful + failed logins in the window. Empty until loaded. */
	byApp: Record<string, number>;
	loading: boolean;
	/** Why the counts are unavailable, when they are. Null while fine. */
	error: string | null;
	loaded: boolean;
}

const INITIAL: State = { byApp: {}, loading: false, error: null, loaded: false };

export function useAppLogins() {
	const [state, setState] = useState<State>(INITIAL);
	const requestIdRef = useRef(0);

	const load = useCallback(async (token: string, accountId: string) => {
		const requestId = ++requestIdRef.current;
		setState((prev) => ({ ...prev, loading: true, error: null }));

		// Cloudflare caps the dataset at a week; asking for more returns an error, not more data.
		const to = new Date();
		const from = new Date(to.getTime() - LOGIN_WINDOW_DAYS * 24 * 60 * 60 * 1000 + 60_000);

		try {
			const result = await fetchAccessUsage<AccessUsageResult>(token, {
				accountId,
				from: from.toISOString(),
				to: to.toISOString(),
				granularity: "day",
			});
			if (requestId !== requestIdRef.current) return;

			const byApp: Record<string, number> = {};
			for (const row of result.byApp) {
				// Join on the uuid, never the display name: names repeat, get renamed, and are
				// absent for an application deleted since its logins were recorded.
				if (row.appId) byApp[row.appId] = row.total;
			}
			setState({ byApp, loading: false, error: null, loaded: true });
		} catch (err) {
			if (requestId !== requestIdRef.current) return;
			// 401/403 is not escalated to a disconnect here: the applications list itself loaded
			// fine under the same token, and only this one column is missing.
			const message =
				err instanceof ApiError && (err.status === 401 || err.status === 403)
					? "Login telemetry needs the Analytics: Read permission on the API token."
					: err instanceof Error
						? err.message
						: "Login telemetry could not be loaded.";
			setState({ byApp: {}, loading: false, error: message, loaded: true });
		}
	}, []);

	return { ...state, load };
}

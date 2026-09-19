// Fetches the five config reports Findings folds in beyond Access/Groups/WAF/Cache, concurrently
// and independently — each source's fetch, success and failure are tracked separately, so a
// single slow or failing source never blocks or hides the others. All five hit routes that are
// edge-cached 60s server side (see src/lib/edge-cache.ts), so calling them from here on every
// mount of the Findings page is cheap: usually a cache hit, never a fresh Cloudflare API fan-out
// unless nothing has asked for that zone's data in the last minute.
//
// Same shape as every other section's loader (usePqcReport, useZoneHealthReport, ...): the hook
// exposes state plus a `load` callback, and the page calls `load` from its own effect keyed on
// the session. That keeps the reset-to-loading state change inside an event handler rather than
// directly inside this hook's own effect body, which react-hooks/set-state-in-effect (rightly)
// flags as a cascading-render risk.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchBotsReport, fetchDnsRecords, fetchPqcReport, fetchTunnelMap, fetchZoneHealthReport } from "../../api/client";
import type { TunnelMapResult } from "../tunnels/types";
import type { ZoneHealthResult } from "../zone-health/types";
import type { PqcResult } from "../pqc/types";
import type { DnsRecordsResult } from "../dns/types";
import type { RatelimitBotResult } from "../bots/types";

export type SourceState<T> =
	| { status: "loading" }
	| { status: "error"; reason: string }
	| { status: "ok"; result: T };

export interface FindingsSourcesState {
	tunnels: SourceState<TunnelMapResult>;
	zoneHealth: SourceState<ZoneHealthResult>;
	pqc: SourceState<PqcResult>;
	dns: SourceState<DnsRecordsResult>;
	bots: SourceState<RatelimitBotResult>;
}

const LOADING_ALL: FindingsSourcesState = {
	tunnels: { status: "loading" },
	zoneHealth: { status: "loading" },
	pqc: { status: "loading" },
	dns: { status: "loading" },
	bots: { status: "loading" },
};

/** What a reader should be told about a failed fetch — named permission gap when it is one. */
export function reasonForError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 401 || err.status === 403) return "Permission missing to read this data.";
		return `Fetch failed: ${err.message}`;
	}
	return `Fetch failed: ${err instanceof Error ? err.message : "unknown error"}`;
}

export function useFindingsSources(onAuthError: () => void) {
	const [state, setState] = useState<FindingsSourcesState>(LOADING_ALL);
	const onAuthErrorRef = useRef(onAuthError);
	useEffect(() => {
		onAuthErrorRef.current = onAuthError;
	}, [onAuthError]);
	const requestIdRef = useRef(0);

	/**
	 * Loads Tunnels, Zone Health, PQC, DNS Records and Rate Limits & Bots.
	 *
	 * Each source is its own fire-and-forget promise so one slow zone-health fan-out never delays
	 * the others from reporting in. A 401/403 from any of them escalates to the shared disconnect
	 * handler once, the same way every other section's loader does — but every source still
	 * resolves its own status, so the sources that *did* answer are not thrown away by one that
	 * needed re-authentication.
	 */
	const load = useCallback((token: string, accountId: string) => {
		const requestId = ++requestIdRef.current;
		setState(LOADING_ALL);
		let authEscalated = false;

		function current() {
			return requestId === requestIdRef.current;
		}

		function escalateIfAuth(err: unknown) {
			if (!authEscalated && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
				authEscalated = true;
				onAuthErrorRef.current();
			}
		}

		function set<K extends keyof FindingsSourcesState>(key: K, value: FindingsSourcesState[K]) {
			if (!current()) return;
			setState((prev) => ({ ...prev, [key]: value }));
		}

		fetchTunnelMap<TunnelMapResult>(token, accountId)
			.then(({ result }) => set("tunnels", { status: "ok", result }))
			.catch((err) => {
				escalateIfAuth(err);
				set("tunnels", { status: "error", reason: reasonForError(err) });
			});

		fetchZoneHealthReport<ZoneHealthResult>(token, accountId)
			.then(({ result }) => set("zoneHealth", { status: "ok", result }))
			.catch((err) => {
				escalateIfAuth(err);
				set("zoneHealth", { status: "error", reason: reasonForError(err) });
			});

		fetchPqcReport<PqcResult>(token, accountId)
			.then(({ result }) => set("pqc", { status: "ok", result }))
			.catch((err) => {
				escalateIfAuth(err);
				set("pqc", { status: "error", reason: reasonForError(err) });
			});

		fetchDnsRecords<DnsRecordsResult>(token, accountId)
			.then(({ result }) => set("dns", { status: "ok", result }))
			.catch((err) => {
				escalateIfAuth(err);
				set("dns", { status: "error", reason: reasonForError(err) });
			});

		fetchBotsReport<RatelimitBotResult>(token, accountId, "")
			.then(({ result }) => set("bots", { status: "ok", result }))
			.catch((err) => {
				escalateIfAuth(err);
				set("bots", { status: "error", reason: reasonForError(err) });
			});
	}, []);

	return { ...state, load };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { storageGet, storageSet } from "../lib/storage";

/**
 * Fake-but-honest progress.
 *
 * There are no server-side progress events — every section is one JSON response — so the bar is
 * estimated against how long this section's last load actually took, decelerating toward 95%
 * until the response lands.
 *
 * The estimate is only worth showing when it came from a measurement. On the first load of a
 * section there is nothing to measure, so `measured` is false and the UI reports elapsed time
 * instead of inventing a countdown; and once elapsed passes the estimate, the remaining time is
 * no longer an estimate of anything, so it stops being offered rather than sitting at "0s".
 */
const DEFAULT_ESTIMATE_MS = 8000;

export interface LoadProgress {
	/** 0–100. Reaches 100 only when the response has actually landed. */
	percent: number;
	/** Milliseconds still expected, or null when no estimate can honestly be given. */
	etaMs: number | null;
	/** Milliseconds since this load began. */
	elapsedMs: number;
	/** Whether `etaMs` derives from a recorded duration rather than the built-in guess. */
	measured: boolean;
	running: boolean;
	start: () => void;
	stop: (success: boolean) => void;
}

export function useEstimatedProgress(storageKey = "cf_zt_last_load_ms"): LoadProgress {
	const [percent, setPercent] = useState(0);
	const [etaMs, setEtaMs] = useState<number | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [measured, setMeasured] = useState(false);
	const [running, setRunning] = useState(false);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const startedAtRef = useRef(0);

	const stopTimer = () => {
		if (timerRef.current !== null) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
	};

	const start = useCallback(() => {
		const stored = Number(storageGet("session", storageKey));
		const hasMeasurement = stored > 0;
		const estimateMs = hasMeasurement ? stored : DEFAULT_ESTIMATE_MS;
		startedAtRef.current = performance.now();
		setPercent(0);
		setElapsedMs(0);
		setMeasured(hasMeasurement);
		// Null on an unmeasured load: the built-in 8s is a placeholder for the curve, not a
		// prediction, and presenting it as one would be a number the app cannot stand behind.
		setEtaMs(hasMeasurement ? estimateMs : null);
		setRunning(true);

		stopTimer();
		timerRef.current = setInterval(() => {
			const elapsed = performance.now() - startedAtRef.current;
			// Asymptotic curve: fast at first, crawls toward 95% until the real response.
			setPercent(Math.min(95, 95 * (1 - Math.exp(-elapsed / estimateMs))));
			setElapsedMs(elapsed);
			// Past the estimate the countdown has nothing left to say, so it stops rather than
			// parking at zero while the reader watches it not finish.
			setEtaMs(hasMeasurement && elapsed < estimateMs ? estimateMs - elapsed : null);
		}, 100);
	}, [storageKey]);

	const stop = useCallback((success: boolean) => {
		stopTimer();
		if (success) {
			const elapsed = performance.now() - startedAtRef.current;
			// Blend with the previous estimate so occasional slow loads don't overreact next time.
			const previous = Number(storageGet("session", storageKey)) || elapsed;
			storageSet("session", storageKey, String(Math.round((previous + elapsed) / 2)));
			setPercent(100);
			setElapsedMs(elapsed);
			setEtaMs(0);
		}
		setTimeout(() => setRunning(false), success ? 250 : 0);
	}, [storageKey]);

	useEffect(() => stopTimer, []);

	return { percent, etaMs, elapsedMs, measured, running, start, stop };
}

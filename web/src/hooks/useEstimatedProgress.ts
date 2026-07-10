import { useCallback, useEffect, useRef, useState } from "react";

// Fake-but-honest progress: no server-side progress events exist (single JSON
// response), so estimate against the last real load duration and decelerate
// toward 95% until the response actually lands, then snap to 100%.
const DEFAULT_ESTIMATE_MS = 8000;

export function useEstimatedProgress(storageKey = "cf_zt_last_load_ms") {
	const [percent, setPercent] = useState(0);
	const [etaMs, setEtaMs] = useState<number | null>(null);
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
		const stored = Number(sessionStorage.getItem(storageKey));
		const estimateMs = stored > 0 ? stored : DEFAULT_ESTIMATE_MS;
		startedAtRef.current = performance.now();
		setPercent(0);
		setEtaMs(estimateMs);
		setRunning(true);

		stopTimer();
		timerRef.current = setInterval(() => {
			const elapsed = performance.now() - startedAtRef.current;
			// Asymptotic curve: fast at first, crawls toward 95% until the real response.
			const next = Math.min(95, 95 * (1 - Math.exp(-elapsed / estimateMs)));
			setPercent(next);
			setEtaMs(Math.max(0, estimateMs - elapsed));
		}, 100);
	}, [storageKey]);

	const stop = useCallback((success: boolean) => {
		stopTimer();
		if (success) {
			const elapsed = performance.now() - startedAtRef.current;
			// Blend with the previous estimate so occasional slow loads don't overreact next time.
			const previous = Number(sessionStorage.getItem(storageKey)) || elapsed;
			sessionStorage.setItem(storageKey, String(Math.round((previous + elapsed) / 2)));
			setPercent(100);
			setEtaMs(0);
		}
		setTimeout(() => setRunning(false), success ? 250 : 0);
	}, [storageKey]);

	useEffect(() => stopTimer, []);

	return { percent, etaMs, running, start, stop };
}

import type { LoadProgress } from "../hooks/useEstimatedProgress";
import { MUTED } from "../lib/ui";

/**
 * What the bar says in words.
 *
 * The rule is that the app never reports a number it cannot stand behind. A countdown is only
 * shown while it is both derived from a real measurement and still ahead of the clock; the rest
 * of the time the reader gets elapsed time, which is always true, and — once the load has
 * outrun its own estimate — a plain statement that this one is slower than usual.
 */
export function progressLabel({ etaMs, elapsedMs, measured, percent }: LoadProgress): string {
	if (percent >= 100) return "Done";
	const elapsed = Math.floor(elapsedMs / 1000);
	if (etaMs !== null && etaMs > 0) {
		// Rounded up: "0s remaining" on a bar that is still moving reads as a stall.
		return `About ${Math.max(1, Math.ceil(etaMs / 1000))}s remaining`;
	}
	if (measured) return `Taking longer than usual — ${elapsed}s so far`;
	// No previous load to measure against, so elapsed time is all there is to report.
	return `Loading — ${elapsed}s`;
}

export function ProgressBar({ progress }: { progress: LoadProgress }) {
	const label = progressLabel(progress);
	return (
		// shrink-0 because Applications puts this in a flex column: without it the bar and its
		// caption are compressible, and a tall table would squeeze them toward nothing.
		<div className="shrink-0">
			<div
				className="overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
				role="progressbar"
				aria-valuenow={Math.round(progress.percent)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuetext={label}
			>
				<div className="h-1.5 rounded-full bg-cf transition-[width] duration-150" style={{ width: `${progress.percent}%` }} />
			</div>
			{/* Polite, not assertive: this updates every tick and must not interrupt a screen
			    reader mid-sentence. The value itself is on the bar's aria-valuetext. */}
			<p className={`mt-1 text-xs tabular-nums ${MUTED}`} aria-hidden>{label}</p>
		</div>
	);
}

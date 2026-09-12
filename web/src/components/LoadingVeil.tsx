import type { ReactNode } from "react";
import type { LoadProgress } from "../hooks/useEstimatedProgress";
import { ProgressBar } from "./ProgressBar";

/**
 * The loading treatment: a progress bar above content that dims while the load runs.
 *
 * Dimmed, not disabled. What is on screen during a reload is the previous load's data — real,
 * just about to be replaced — and the reader may well want to keep reading it or adjust a filter
 * while they wait. Fading says "this is going stale" without taking the page away; `aria-busy`
 * says the same thing to a screen reader, which gets no benefit from the opacity.
 *
 * The bar sits outside the dimmed region deliberately. It is the one thing on screen that is not
 * going stale, and fading the progress indicator along with the content it describes would be
 * the opposite of what it is for.
 *
 * Separate from PageShell because Applications does not use PageShell — its table owns the
 * scrolling — and a second spelling of "dim while loading" is exactly the drift this replaced.
 */
export function LoadingVeil({ progress, children, className }: {
	progress: LoadProgress | undefined;
	children: ReactNode;
	/** Layout for the content region; the veil itself only adds opacity. */
	className?: string;
}) {
	const loading = progress?.running ?? false;
	return (
		<>
			{progress?.running && <ProgressBar progress={progress} />}
			<div
				aria-busy={loading}
				className={`transition-opacity duration-200 ${loading ? "opacity-50" : "opacity-100"} ${className ?? ""}`}
			>
				{children}
			</div>
		</>
	);
}

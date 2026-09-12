import type { ReactNode } from "react";
import type { LoadProgress } from "../hooks/useEstimatedProgress";
import { LoadingVeil } from "./LoadingVeil";

/**
 * The frame every section renders inside.
 *
 * Sections used to disagree about their own outline: nine scrolled with
 * `overflow-auto p-4 md:p-6` and spaced their children with a `mb-4` on each one, five used
 * `overflow-y-auto` with an inner `space-y-4` wrapper. The gap between children came out the same
 * either way, so the drift was invisible until a page needed to change — and then it was two
 * different edits. It is one edit now.
 *
 * `overflow-auto` rather than `overflow-y-auto`: wide tables and charts exist, and clipping them
 * with no way to reach the right-hand edge is worse than a horizontal scrollbar.
 *
 * Pass `progress` and the shell handles the whole loading treatment — see LoadingVeil. A section
 * that renders its own progress bar as a child would have it dim along with the data.
 */
export function PageShell({ children, id, progress }: { children: ReactNode; id?: string; progress?: LoadProgress }) {
	return (
		<div className="h-full overflow-auto" id={id}>
			<div className="space-y-4 p-4 md:p-6">
				<LoadingVeil progress={progress} className="space-y-4">{children}</LoadingVeil>
			</div>
		</div>
	);
}

import type { ReactNode } from "react";

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
 */
export function PageShell({ children, id }: { children: ReactNode; id?: string }) {
	return (
		<div className="h-full overflow-auto" id={id}>
			<div className="space-y-4 p-4 md:p-6">{children}</div>
		</div>
	);
}

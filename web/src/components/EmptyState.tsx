import type { ReactNode } from "react";
import { CARD, MUTED } from "../lib/ui";

/**
 * What a section shows when it has nothing to show.
 *
 * There were four shapes of this and the wording drifted with them — "No data for this time
 * range", "No data in this range", "Nothing to show for this filter." An empty result is one of
 * the two or three things a reader sees most often, and it is the moment they are most likely to
 * wonder whether the app is broken. So it gets one shape and one voice.
 *
 * `title` says what is absent. `hint` says why, when the reason is actionable — a filter that
 * excludes everything is the operator's to undo, an account with nothing configured is not.
 */
export function EmptyState({ icon: Icon, iconClass, title, hint }: {
	icon?: (props: { size?: number; className?: string }) => ReactNode;
	/** Overrides the muted default — the Findings page's "all clear" icon is green on purpose. */
	iconClass?: string;
	title: string;
	hint?: ReactNode;
}) {
	return (
		<div className={`${CARD} px-8 py-12 text-center`}>
			{Icon && <div className={`mb-3 ${iconClass ?? MUTED}`}><Icon size={28} className="mx-auto" /></div>}
			<h2 className="text-base font-semibold">{title}</h2>
			{hint && <p className={`mx-auto mt-1.5 max-w-prose text-sm ${MUTED}`}>{hint}</p>}
		</div>
	);
}

/**
 * The same absence, inside a table that already has a header worth keeping on screen.
 *
 * `loading` is a separate state on purpose: "no rows yet" and "no rows at all" are different
 * facts, and a table that shows the empty message while it is still fetching tells the reader
 * something untrue.
 */
export function EmptyRow({ colSpan, title, loading = false }: { colSpan: number; title: string; loading?: boolean }) {
	return (
		<tr>
			<td colSpan={colSpan} className={`px-4 py-12 text-center text-sm ${MUTED}`}>
				{loading ? "Loading…" : title}
			</td>
		</tr>
	);
}

/**
 * The same absence, inside a card that already carries a heading.
 *
 * Smaller than `EmptyState` because the heading above it has already said what the card is; this
 * only has to say that there is nothing in it.
 */
export function EmptyNote({ title, loading = false }: { title: string; loading?: boolean }) {
	return <p className={`py-10 text-center text-sm ${MUTED}`}>{loading ? "Loading…" : title}</p>;
}

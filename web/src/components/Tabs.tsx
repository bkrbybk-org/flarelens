import { useRef, type ReactNode } from "react";
import { FOCUS_RING } from "../lib/ui";

/**
 * A tab strip that keeps the ARIA tabs contract.
 *
 * Two sections had hand-rolled tab strips with identical markup, and both were half of the
 * pattern: `role="tablist"` and `role="tab"` were there, but nothing carried `role="tabpanel"`,
 * no tab pointed at the panel it controls, and the arrow keys did nothing. A screen reader
 * announced "tab 1 of 2" and then had no way to say what either tab led to.
 *
 * The strip owns a roving tabindex: exactly one tab is in the tab order, and Left/Right (plus
 * Home/End) move between them. That is what the pattern requires, and it is also what makes a
 * two-tab strip cost one Tab keypress to pass rather than two.
 */
export interface TabSpec<T extends string> {
	id: T;
	label: ReactNode;
}

export function Tabs<T extends string>({ tabs, active, onChange, label, idPrefix }: {
	tabs: TabSpec<T>[];
	active: T;
	onChange: (id: T) => void;
	/** Names the strip itself, for a reader arriving at it out of context. */
	label: string;
	/** Namespaces the generated ids so two strips on one page cannot collide. */
	idPrefix: string;
}) {
	const refs = useRef<Record<string, HTMLButtonElement | null>>({});

	const move = (from: number, delta: number) => {
		const next = tabs[(from + delta + tabs.length) % tabs.length];
		onChange(next.id);
		// Focus follows selection: the pattern's automatic-activation form, which suits strips
		// whose panels are already loaded and cheap to swap.
		refs.current[next.id]?.focus();
	};

	return (
		<div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist" aria-label={label}>
			{tabs.map((tab, i) => {
				const selected = tab.id === active;
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={`${idPrefix}-tab-${tab.id}`}
						aria-selected={selected}
						aria-controls={`${idPrefix}-panel-${tab.id}`}
						tabIndex={selected ? 0 : -1}
						ref={(el) => { refs.current[tab.id] = el; }}
						onClick={() => onChange(tab.id)}
						onKeyDown={(e) => {
							if (e.key === "ArrowRight") { e.preventDefault(); move(i, 1); }
							else if (e.key === "ArrowLeft") { e.preventDefault(); move(i, -1); }
							else if (e.key === "Home") { e.preventDefault(); move(0, 0); }
							else if (e.key === "End") { e.preventDefault(); move(tabs.length - 1, 0); }
						}}
						className={
							selected
								? `border-b-2 border-cf px-4 py-2 text-sm font-medium text-cf ${FOCUS_RING}`
								: `border-b-2 border-transparent px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 ${FOCUS_RING}`
						}
					>
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}

/** The panel a tab controls. Ids must match the strip's `idPrefix` and the tab's own id. */
export function TabPanel({ id, idPrefix, children }: { id: string; idPrefix: string; children: ReactNode }) {
	return (
		<div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0} className="focus-visible:outline-none">
			{children}
		</div>
	);
}

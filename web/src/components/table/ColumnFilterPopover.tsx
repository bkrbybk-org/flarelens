import { useEffect, useRef, useState } from "react";
import { FOCUS_RING } from "../../lib/ui";

export interface ColumnFilterValue {
	selected: string[];
	query: string;
}

export const EMPTY_COLUMN_FILTER: ColumnFilterValue = { selected: [], query: "" };

export function isColumnFilterActive(value: ColumnFilterValue): boolean {
	return value.selected.length > 0 || value.query !== "";
}

interface ColumnFilterPopoverProps {
	title: string;
	anchor: { left: number; top: number };
	values: string[];
	current: ColumnFilterValue;
	onChange: (next: ColumnFilterValue) => void;
	onClose: () => void;
}

// Excel-style column filter: checkbox list of distinct values plus a
// type-to-search box that doubles as a contains-filter when nothing is checked.
// Rendered position: fixed, so scroll containers cannot clip it.
export function ColumnFilterPopover({ title, anchor, values, current, onChange, onClose }: ColumnFilterPopoverProps) {
	const [listSearch, setListSearch] = useState(current.query);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) {
				onClose();
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	const shown = listSearch
		? values.filter((v) => v.toLowerCase().includes(listSearch.toLowerCase()))
		: values;

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={`Filter ${title}`}
			style={{ left: anchor.left, top: anchor.top }}
			className="fixed z-50 w-72 rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
		>
			<div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
				<input
					type="search"
					autoFocus
					value={listSearch}
					onChange={(e) => {
						setListSearch(e.target.value);
						onChange({ selected: current.selected, query: e.target.value });
					}}
					placeholder={`Type to filter ${title.toLowerCase()}…`}
					className={`w-full rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-cf dark:border-zinc-700 ${FOCUS_RING}`}
				/>
			</div>
			<div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
				<button
					type="button"
					onClick={() => onChange({ selected: shown, query: current.query })}
					className="font-medium text-cf hover:underline"
				>
					Select all{listSearch ? " shown" : ""}
				</button>
				<button
					type="button"
					onClick={() => {
						onChange({ selected: [], query: "" });
						setListSearch("");
					}}
					className="text-zinc-500 hover:underline dark:text-zinc-400"
				>
					Clear filter
				</button>
			</div>
			<div className="max-h-64 overflow-y-auto p-1.5">
				{shown.length === 0 ? (
					<p className="px-2 py-3 text-center text-xs text-zinc-500 dark:text-zinc-400">No values match.</p>
				) : (
					shown.map((value) => (
						<label key={value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
							<input
								type="checkbox"
								checked={current.selected.includes(value)}
								onChange={(e) => {
									const selected = e.target.checked
										? [...current.selected, value]
										: current.selected.filter((v) => v !== value);
									onChange({ selected, query: current.query });
								}}
								className="accent-cf"
							/>
							<span className="min-w-0 flex-1 truncate" title={value}>{value}</span>
						</label>
					))
				)}
			</div>
			{isColumnFilterActive(current) && (
				<div className="border-t border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
					{current.selected.length > 0
						? `${current.selected.length} value${current.selected.length > 1 ? "s" : ""} selected`
						: "Text filter active"}
				</div>
			)}
		</div>
	);
}

// Shared filterFn body for TanStack columns using facet-based filtering.
export function facetFilterPasses(facets: string[], filterValue: ColumnFilterValue): boolean {
	const { selected, query } = filterValue;
	if (selected.length > 0) {
		return facets.some((f) => selected.includes(f));
	}
	if (query) {
		const q = query.toLowerCase();
		return facets.some((f) => f.toLowerCase().includes(q));
	}
	return true;
}

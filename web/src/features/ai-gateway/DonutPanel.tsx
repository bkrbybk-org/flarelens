import { FOCUS_RING, MUTED, CARD } from "../../lib/ui";
import { OTHER, colorFor } from "./stack";

/**
 * One share-of-total ring with its legend — the cost view's "by service / by location" panels.
 * The dimension is picked per panel; a slice of a drillable dimension narrows the page to it.
 */

export interface DonutSlice {
	key: string;
	value: number;
}

const TOP = 6;
const R = 52;
const STROKE = 22;
const C = 2 * Math.PI * R;

/** The biggest slices, the rest folded into "Other"; zero and negative values left out. */
export function topSlices(slices: DonutSlice[]): DonutSlice[] {
	const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
	if (sorted.length <= TOP + 1) return sorted;
	const rest = sorted.slice(TOP).reduce((n, s) => n + s.value, 0);
	return [...sorted.slice(0, TOP), { key: OTHER, value: rest }];
}

export function DonutPanel<D extends string>({
	dimension,
	dimensions,
	onDimension,
	slices,
	format,
	label = (key) => key,
	onPick,
	idPrefix,
}: {
	dimension: D;
	dimensions: { id: D; label: string }[];
	onDimension: (id: D) => void;
	slices: DonutSlice[];
	format: (value: number) => string;
	label?: (key: string) => string;
	onPick?: (key: string) => void;
	idPrefix: string;
}) {
	const shown = topSlices(slices);
	const total = shown.reduce((n, s) => n + s.value, 0);
	// Where each slice starts around the ring.
	const starts = shown.map((_, i) => shown.slice(0, i).reduce((n, s) => n + (s.value / total) * C, 0));
	return (
		<section className={CARD}>
			<label className="mb-3 flex items-center gap-2 text-sm font-semibold">
				<span className="sr-only">Donut dimension</span>
				<select
					id={`${idPrefix}-dimension`}
					value={dimension}
					onChange={(e) => onDimension(e.target.value as D)}
					className={`rounded-md border border-transparent bg-transparent py-0.5 pr-1 text-sm font-semibold hover:border-zinc-300 dark:hover:border-zinc-700 ${FOCUS_RING}`}
				>
					{dimensions.map((d) => (
						<option key={d.id} value={d.id}>{d.label}</option>
					))}
				</select>
			</label>
			{!total ? (
				<p className={`py-8 text-center text-sm ${MUTED}`}>Nothing to show for this measure.</p>
			) : (
				<div className="flex flex-wrap items-center gap-4">
					<svg viewBox="0 0 140 140" className="h-32 w-32 shrink-0" role="img" aria-label={`Share by ${dimensions.find((d) => d.id === dimension)?.label ?? dimension}`}>
						<g transform="rotate(-90 70 70)">
							{shown.map((s, i) => {
								const length = (s.value / total) * C;
								return (
									<circle
										key={s.key}
										cx={70}
										cy={70}
										r={R}
										fill="none"
										stroke={colorFor(s.key, i, "model")}
										strokeWidth={STROKE}
										strokeDasharray={`${Math.max(0, length - 1)} ${C}`}
										strokeDashoffset={-starts[i]}
									/>
								);
							})}
						</g>
					</svg>
					<ul className="min-w-0 flex-1 space-y-1.5 text-sm">
						{shown.map((s, i) => {
							const content = (
								<>
									<span aria-hidden className="mt-1 h-8 w-1 shrink-0 rounded-full" style={{ background: colorFor(s.key, i, "model") }} />
									<span className="min-w-0">
										<span className={`block truncate text-xs ${MUTED}`} title={label(s.key)}>{label(s.key)}</span>
										<span className="block text-lg font-semibold tabular-nums leading-tight">{format(s.value)}</span>
									</span>
								</>
							);
							return (
								<li key={s.key}>
									{onPick && s.key !== OTHER && s.key !== "(unknown)" && s.key !== "(not tagged)" ? (
										<button type="button" onClick={() => onPick(s.key)} className={`flex w-full gap-2 text-left hover:underline ${FOCUS_RING}`} title={`Drill into ${label(s.key)}`}>
											{content}
										</button>
									) : (
										<span className="flex gap-2">{content}</span>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</section>
	);
}

import type { ReactNode } from "react";
import { CARD, MUTED } from "../lib/ui";

/**
 * A single headline number.
 *
 * The app had two of these. Six sections used a label above a large value; three used a coloured
 * icon beside a smaller value with the label underneath. Both were reasonable, and the choice
 * between them was whichever page the author had copied — so the same account's numbers changed
 * shape as the reader moved between sections.
 *
 * This is the label-above-value form, because it is the one that already carried a `hint` line,
 * and a hint is what stops a number being misread. The icon survives as an option rather than a
 * second layout: the sections that had colour-coded icons keep them, and the ones that never
 * needed an icon do not grow one.
 *
 * `value` takes a number so the component can do the thousands separators rather than trusting
 * every call site to remember `toLocaleString`. Pass a string when the value is already formatted
 * (a percentage, a currency amount, a duration).
 */
export function StatCard({ label, value, hint, tone, icon: Icon, iconClass, detail }: {
	label: string;
	value: string | number;
	/** Why the number is what it is, or what it excludes. Muted, below the value. */
	hint?: ReactNode;
	/** Colour for the value itself, when the number carries a verdict. */
	tone?: string;
	icon?: (props: { size?: number; className?: string }) => ReactNode;
	iconClass?: string;
	/** A breakdown rendered under the value, for the rare card that needs more than a hint. */
	detail?: ReactNode;
}) {
	return (
		<div className={CARD}>
			<div className="flex items-center gap-2">
				{Icon && (
					<span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconClass ?? "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"}`}>
						<Icon size={15} />
					</span>
				)}
				<div className={`min-w-0 truncate text-xs font-medium uppercase tracking-wide ${MUTED}`}>{label}</div>
			</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>
				{typeof value === "number" ? value.toLocaleString() : value}
			</div>
			{hint && <div className={`mt-0.5 text-xs ${MUTED}`}>{hint}</div>}
			{detail && <div className="mt-1">{detail}</div>}
		</div>
	);
}

/**
 * The row these sit in.
 *
 * Two columns on a phone, `cols` on a wide screen. One section reflowed at `sm` and `xl` instead
 * of `lg`, so on a tablet its KPIs stacked differently from every other section's; there is only
 * one breakpoint here for that reason.
 */
const COLS: Record<number, string> = {
	2: "lg:grid-cols-2",
	3: "lg:grid-cols-3",
	4: "lg:grid-cols-4",
	5: "lg:grid-cols-5",
	6: "lg:grid-cols-6",
};

export function StatGrid({ cols, children }: { cols: 2 | 3 | 4 | 5 | 6; children: ReactNode }) {
	return <div className={`grid grid-cols-2 gap-3 ${COLS[cols]}`}>{children}</div>;
}

import { decisionTone, type DecisionTone } from "../../lib/rules";

const TONE_CLASSES: Record<DecisionTone, string> = {
	allow: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	deny: "bg-red-500/15 text-red-600 dark:text-red-400",
	warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	neutral: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

export function DecisionBadge({ decision }: { decision: string }) {
	return (
		<span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${TONE_CLASSES[decisionTone(decision)]}`}>
			{decision.replaceAll("_", " ")}
		</span>
	);
}

export function PolicyChip({ name, decision }: { name: string; decision: string }) {
	return (
		<span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs dark:border-zinc-700/60 dark:bg-zinc-800/60">
			<span className="truncate font-medium">{name}</span>
			<DecisionBadge decision={decision} />
		</span>
	);
}

export function Tag({ label }: { label: string }) {
	return (
		<span className="inline-flex items-center rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300">
			{label}
		</span>
	);
}

export function ErrorBadge({ label }: { label: string }) {
	return (
		<span className="inline-flex items-center rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
			{label}
		</span>
	);
}

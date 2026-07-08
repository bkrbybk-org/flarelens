import { describeRule, RULE_SECTIONS, type RuleContext } from "../../lib/rules";
import type { CfPolicy } from "../../types";

const SECTION_TITLE_CLASSES: Record<string, string> = {
	include: "text-emerald-600 dark:text-emerald-400",
	require: "text-cf",
	exclude: "text-red-600 dark:text-red-400",
};

export function RuleList({ policy, ctx }: { policy: CfPolicy; ctx: RuleContext }) {
	const sections = RULE_SECTIONS.filter(
		({ field }) => Array.isArray(policy[field]) && (policy[field] as unknown[]).length > 0,
	);

	if (sections.length === 0) {
		return <p className="text-sm text-zinc-500 dark:text-zinc-400">No rules defined.</p>;
	}

	return (
		<div className="space-y-3">
			{sections.map(({ field, label }) => (
				<div key={field}>
					<h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${SECTION_TITLE_CLASSES[field]}`}>
						{label}
					</h4>
					<ul className="space-y-1">
						{(policy[field] as unknown[]).map((rule, i) => (
							<li
								key={i}
								className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm break-words dark:border-zinc-700/60 dark:bg-zinc-800/50"
							>
								{describeRule(rule, ctx)}
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

import { describeRule, RULE_SECTIONS, type RuleContext } from "../../lib/rules";
import type { CfList, CfPolicy } from "../../types";

const SECTION_TITLE_CLASSES: Record<string, string> = {
	include: "text-emerald-600 dark:text-emerald-400",
	require: "text-cf",
	exclude: "text-red-600 dark:text-red-400",
};

/** The list id a rule references, if it references one at all. */
function referencedListId(rule: unknown): string | null {
	if (!rule || typeof rule !== "object") return null;
	for (const [key, value] of Object.entries(rule as Record<string, unknown>)) {
		if (!key.endsWith("_list") || !value || typeof value !== "object") continue;
		const id = (value as { id?: unknown }).id;
		if (typeof id === "string" && id) return id;
	}
	return null;
}

/**
 * The entries behind a referenced list.
 *
 * A rule reading "Email in list …" is unreviewable on its own — the question a policy review asks
 * is who it lets in. Collapsed by default because a list can hold hundreds of entries and the
 * rule sentence is usually enough; the count is on the summary either way.
 */
function ListContents({ list }: { list: CfList }) {
	if (list.error) {
		return (
			<p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
				Entries could not be read: {list.error}
			</p>
		);
	}
	if (list.items.length === 0) {
		return <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">This list is empty.</p>;
	}

	return (
		<details className="mt-1.5">
			<summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
				Show {list.items.length === list.count ? "all " : ""}
				{list.items.length} {list.items.length === 1 ? "entry" : "entries"}
			</summary>
			<ul className="mt-1.5 flex flex-wrap gap-1">
				{list.items.map((item) => (
					<li
						key={item}
						className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[11px] dark:border-zinc-700 dark:bg-zinc-900"
					>
						{item}
					</li>
				))}
			</ul>
			{list.items_truncated && (
				// Stating the cap matters: a reader must not take a capped view for the whole list.
				<p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
					Showing the first {list.items.length} of {list.count}. The rest are in the Cloudflare dashboard.
				</p>
			)}
		</details>
	);
}

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
						{(policy[field] as unknown[]).map((rule, i) => {
							const listId = referencedListId(rule);
							const list = listId ? ctx.list?.(listId) : undefined;
							return (
								<li
									key={i}
									className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm break-words dark:border-zinc-700/60 dark:bg-zinc-800/50"
								>
									{describeRule(rule, ctx)}
									{list && <ListContents list={list} />}
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}

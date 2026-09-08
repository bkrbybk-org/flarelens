import { useMemo, useState } from "react";
import { SearchIcon, UsersIcon } from "../../components/Icons";
import { ProgressBar } from "../../components/ProgressBar";
import { useHashSyncedState } from "../../hooks/useHashParams";
import { groupUsedBy, reusablePolicyUsedBy } from "../../lib/findings";
import { formatLocalDateTime, type RuleContext } from "../../lib/rules";
import type { CfApp, CfGroup, CfPolicy } from "../../types";
import { DecisionBadge, Tag } from "./PolicyChip";
import { RuleList } from "./RuleList";

type Tab = "groups" | "policies";

interface GroupsPageProps {
	groups: CfGroup[];
	groupsError: boolean;
	apps: CfApp[];
	/** Reusable policies by id, so a group used only through one is not reported as unreferenced. */
	reusableMap: Record<string, CfPolicy>;
	/** The same policies as a list, for the Reusable policies tab. */
	reusablePolicies: CfPolicy[];
	/** True when the token could not read account-level policies at all. */
	reusablePoliciesError: boolean;
	loading: boolean;
	error: string | null;
	progressPercent: number;
	progressRunning: boolean;
	ctx: RuleContext;
}

export function GroupsPage({
	groups,
	groupsError,
	apps,
	reusableMap,
	reusablePolicies,
	reusablePoliciesError,
	loading,
	error,
	progressPercent,
	progressRunning,
	ctx,
}: GroupsPageProps) {
	const [search, setSearch] = useState("");
	const [tab, setTab] = useState<Tab>("groups");

	// Deep-linkable, like the WAF section's tabs: #/groups?tab=policies
	useHashSyncedState("tab", tab, (next) => setTab(next === "policies" ? "policies" : "groups"), "groups");

	// group id → app names whose policies reference it
	const usedBy = useMemo(() => groupUsedBy(groups, apps, reusableMap), [groups, apps, reusableMap]);

	// policy id → app names that attach it by reference
	const policyUsedBy = useMemo(() => reusablePolicyUsedBy(reusablePolicies, apps), [reusablePolicies, apps]);

	const filteredPolicies = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return reusablePolicies;
		return reusablePolicies.filter((p) =>
			[p.name || "", p.id, p.decision || "", JSON.stringify(p.include || []), JSON.stringify(p.exclude || []), JSON.stringify(p.require || [])]
				.join(" ")
				.toLowerCase()
				.includes(q),
		);
	}, [reusablePolicies, search]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return groups;
		return groups.filter((g) =>
			[g.name || "", g.id, JSON.stringify(g.include || []), JSON.stringify(g.exclude || []), JSON.stringify(g.require || [])]
				.join(" ")
				.toLowerCase()
				.includes(q),
		);
	}, [groups, search]);

	return (
		<div className="h-full overflow-y-auto">
			<div className="space-y-4 p-4 md:p-6">
				{progressRunning && <ProgressBar percent={progressPercent} />}

				{error && (
					<div role="alert" className="rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
						{error}
					</div>
				)}

				<div className="relative">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={tab === "policies" ? "Search policies, decisions, rules…" : "Search groups, rules…"}
						disabled={loading}
						className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</div>

				{/* Two views of the same account-level configuration: the rule groups themselves, and
				    the reusable policies that reference them. Both are attached to applications by
				    reference, and neither is visible on the Applications page. */}
				<div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist">
					{([["groups", `Rule groups (${groups.length})`], ["policies", `Reusable policies (${reusablePolicies.length})`]] as [Tab, string][]).map(
						([id, label]) => (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={tab === id}
								onClick={() => setTab(id)}
								className={
									tab === id
										? "border-b-2 border-cf px-4 py-2 text-sm font-medium text-cf"
										: "border-b-2 border-transparent px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
								}
							>
								{label}
							</button>
						),
					)}
				</div>

				{tab === "policies" ? (
					!loading && filteredPolicies.length === 0 ? (
						<div className="rounded-2xl border border-zinc-200 bg-white px-8 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
							<UsersIcon size={28} className="mx-auto mb-3 text-zinc-400" />
							<h2 className="text-base font-semibold">
								{reusablePolicies.length === 0 ? "No reusable policies" : "No policies match"}
							</h2>
							<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
								{reusablePolicies.length === 0
									? reusablePoliciesError
										? "Account-level policies could not be fetched — the API token is missing the Access: Organizations, Identity Providers, and Groups (Read) permission."
										: "This account defines no reusable policies; every application carries its own."
									: "Try a different search."}
							</p>
						</div>
					) : (
						<div className="space-y-3">
							{filteredPolicies.map((policy) => {
								const attachedTo = policyUsedBy.get(policy.id) || [];
								return (
									<div key={policy.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
										<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
											<div className="flex min-w-0 items-center gap-2">
												<h3 className="min-w-0 truncate font-medium">{policy.name || policy.id}</h3>
												{policy.decision && <DecisionBadge decision={policy.decision} />}
											</div>
											<span className="text-xs text-zinc-400">
												{policy.updated_at != null && <>Updated {formatLocalDateTime(policy.updated_at)}</>}
											</span>
										</div>

										<RuleList policy={policy} ctx={ctx} />

										<div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
											<span className="text-zinc-500 dark:text-zinc-400">
												{attachedTo.length
													? `Attached to ${attachedTo.length} application${attachedTo.length === 1 ? "" : "s"}:`
													: "Not attached to any application — this policy enforces nothing."}
											</span>
											{attachedTo.map((name) => <Tag key={name} label={name} />)}
										</div>

										<details className="mt-3">
											<summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
												Raw JSON
											</summary>
											<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950">
												{JSON.stringify(policy, null, 2)}
											</pre>
										</details>
									</div>
								);
							})}
						</div>
					)
				) : !loading && filtered.length === 0 ? (
					<div className="rounded-2xl border border-zinc-200 bg-white px-8 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
						<UsersIcon size={28} className="mx-auto mb-3 text-zinc-400" />
						<h2 className="text-base font-semibold">
							{groups.length === 0 ? "No Access Groups" : "No groups match"}
						</h2>
						<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
							{groups.length === 0
								? groupsError
									? "The API token is missing the Access: Organizations, Identity Providers, and Groups (Read) permission — groups could not be fetched."
									: "This account has no Access Groups configured."
								: "Try a different search."}
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{filtered.map((group) => {
							const referencedBy = usedBy.get(group.id) || [];
							return (
								<div key={group.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
									<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
										<h3 className="min-w-0 truncate font-medium">{group.name || group.id}</h3>
										<span className="text-xs text-zinc-400">
											{group.updated_at != null && <>Updated {formatLocalDateTime(group.updated_at)}</>}
										</span>
									</div>

									<RuleList
										policy={{ id: group.id, include: group.include, exclude: group.exclude, require: group.require }}
										ctx={ctx}
									/>

									<div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
										<span className="text-zinc-500 dark:text-zinc-400">
											{referencedBy.length
												? `Used by ${referencedBy.length} application${referencedBy.length === 1 ? "" : "s"}:`
												: "Not referenced by any application policy."}
										</span>
										{referencedBy.map((name) => <Tag key={name} label={name} />)}
									</div>

									<details className="mt-3">
										<summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
											Raw JSON
										</summary>
										<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950">
											{JSON.stringify(group, null, 2)}
										</pre>
									</details>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

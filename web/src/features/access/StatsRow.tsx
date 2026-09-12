import { useMemo } from "react";
import type { CfApp } from "../../types";
import { AlertIcon, AppsIcon, KeyIcon, UsersIcon } from "../../components/Icons";

interface StatsRowProps {
	apps: CfApp[];
	idpCount: number;
}

export function StatsRow({ apps, idpCount }: StatsRowProps) {
	const stats = useMemo(() => {
		let policies = 0;
		let allow = 0;
		let deny = 0;
		let errors = 0;
		for (const app of apps) {
			if (app.policies_error) errors++;
			for (const policy of app.policies) {
				policies++;
				const d = (policy.decision || "").toLowerCase();
				if (d === "allow") allow++;
				else if (d === "deny") deny++;
			}
		}
		return { policies, allow, deny, other: policies - allow - deny, errors };
	}, [apps]);

	const cards = [
		{
			label: "Applications",
			value: apps.length,
			icon: AppsIcon,
			detail: null,
			iconClass: "bg-cf/15 text-cf",
		},
		{
			label: "Policies",
			value: stats.policies,
			icon: KeyIcon,
			detail: (
				<span className="flex gap-2 text-xs">
					<span className="text-emerald-600 dark:text-emerald-400">{stats.allow} allow</span>
					<span className="text-red-600 dark:text-red-400">{stats.deny} deny</span>
					{stats.other > 0 && <span className="text-zinc-500">{stats.other} other</span>}
				</span>
			),
			iconClass: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
		},
		{
			label: "Identity Providers",
			value: idpCount,
			icon: UsersIcon,
			detail: null,
			iconClass: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
		},
		{
			label: "Fetch Errors",
			value: stats.errors,
			icon: AlertIcon,
			detail: stats.errors > 0 ? <span className="text-xs text-red-500">policies unavailable</span> : null,
			iconClass: stats.errors > 0
				? "bg-red-500/15 text-red-600 dark:text-red-400"
				: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
		},
	];

	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
			{cards.map(({ label, value, icon: Icon, detail, iconClass }) => (
				<div key={label} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
					<span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconClass}`}>
						<Icon size={18} />
					</span>
					<div className="min-w-0 leading-tight">
						<div className="text-xl font-semibold tabular-nums">{value}</div>
						<div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
						{detail}
					</div>
				</div>
			))}
		</div>
	);
}

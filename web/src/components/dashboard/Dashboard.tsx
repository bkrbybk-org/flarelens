import { useMemo, useState } from "react";
import type { CfApp, CfPolicy } from "../../types";
import type { RuleContext } from "../../lib/rules";
import type { Prefs } from "../../hooks/usePrefs";
import { AppsTable } from "./AppsTable";
import { DetailDrawer } from "./DetailDrawer";
import { StatsRow } from "./StatsRow";

interface DashboardProps {
	apps: CfApp[];
	idpCount: number;
	loading: boolean;
	error: string | null;
	progressPercent: number;
	progressRunning: boolean;
	ctx: RuleContext;
	reusableMap: Record<string, CfPolicy>;
	prefs: Prefs;
	updatePrefs: (patch: Partial<Prefs>) => void;
}

export function Dashboard({
	apps, idpCount, loading, error,
	progressPercent, progressRunning,
	ctx, reusableMap, prefs, updatePrefs,
}: DashboardProps) {
	const [idpFilter, setIdpFilter] = useState("");
	const [tagFilter, setTagFilter] = useState("");
	const [selectedApp, setSelectedApp] = useState<CfApp | null>(null);

	const { uniqueIdps, uniqueTags } = useMemo(() => {
		const idps = new Set<string>();
		const tags = new Set<string>();
		for (const app of apps) {
			for (const id of app.allowed_idps || []) idps.add(id);
			for (const tag of app.tags || []) tags.add(tag);
		}
		const byName = (a: string, b: string) => ctx.idpName(a).localeCompare(ctx.idpName(b));
		return {
			uniqueIdps: [...idps].sort(byName),
			uniqueTags: [...tags].sort((a, b) => a.localeCompare(b)),
		};
	}, [apps, ctx]);

	const filteredApps = useMemo(
		() =>
			apps.filter((app) => {
				if (idpFilter && !(app.allowed_idps || []).includes(idpFilter)) return false;
				if (tagFilter && !(app.tags || []).includes(tagFilter)) return false;
				return true;
			}),
		[apps, idpFilter, tagFilter],
	);

	const selectClasses =
		"rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900";

	return (
		<div className="flex h-full flex-col gap-4 p-4 md:p-6">
			{progressRunning && (
				<div className="overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={Math.round(progressPercent)} aria-valuemin={0} aria-valuemax={100}>
					<div
						className="h-1.5 rounded-full bg-cf transition-[width] duration-150"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
			)}

			{error && (
				<div role="alert" className="rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
					{error}
				</div>
			)}

			<StatsRow apps={filteredApps} idpCount={idpCount} />

			<div className="flex flex-wrap gap-2">
				<select value={idpFilter} onChange={(e) => setIdpFilter(e.target.value)} aria-label="Filter by identity provider" disabled={loading} className={selectClasses}>
					<option value="">All IdPs</option>
					{uniqueIdps.map((id) => <option key={id} value={id}>{ctx.idpName(id)}</option>)}
				</select>
				<select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag" disabled={loading} className={selectClasses}>
					<option value="">All Tags</option>
					{uniqueTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
				</select>
			</div>

			<AppsTable
				apps={filteredApps}
				loading={loading}
				ctx={ctx}
				reusableMap={reusableMap}
				onSelect={setSelectedApp}
				perPage={prefs.perPage}
				density={prefs.density}
				columnVisibility={prefs.columnVisibility}
				columnOrder={prefs.columnOrder}
				onPrefsChange={updatePrefs}
			/>

			<DetailDrawer app={selectedApp} onClose={() => setSelectedApp(null)} ctx={ctx} reusableMap={reusableMap} />
		</div>
	);
}

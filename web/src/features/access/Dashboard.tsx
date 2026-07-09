import { useState } from "react";
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
	const [selectedApp, setSelectedApp] = useState<CfApp | null>(null);

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

			<StatsRow apps={apps} idpCount={idpCount} />

			<AppsTable
				apps={apps}
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

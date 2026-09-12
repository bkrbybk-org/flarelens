import { useState } from "react";
import { ALERT_ERROR, ALERT_WARN } from "../../lib/ui";
import { ProgressBar } from "../../components/ProgressBar";
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
	/** Set when the Logins (7d) column could not be filled; the table says so rather than showing zeros. */
	loginsError?: string | null;
	prefs: Prefs;
	updatePrefs: (patch: Partial<Prefs>) => void;
}

export function Dashboard({
	apps, idpCount, loading, error,
	progressPercent, progressRunning,
	ctx, reusableMap, loginsError, prefs, updatePrefs,
}: DashboardProps) {
	const [selectedApp, setSelectedApp] = useState<CfApp | null>(null);

	return (
		<div className="flex h-full flex-col gap-4 p-4 md:p-6">
			{progressRunning && <ProgressBar percent={progressPercent} />}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			{/* Stated rather than left as an empty column: a reader who sees dashes needs to know
			    whether nobody signed in or nobody could read the telemetry. */}
			{loginsError && (
				<div role="status" className={ALERT_WARN}>
					Logins (7d) unavailable — {loginsError}
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

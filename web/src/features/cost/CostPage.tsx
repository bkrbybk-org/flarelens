import { useCallback, useEffect, useState } from "react";
import { useSectionRefresh } from "../../hooks/useSectionRefresh";
import { PageShell } from "../../components/PageShell";
import { ALERT_ERROR, CARD, CARD_HEADER, FOCUS_RING, SECTION_TITLE } from "../../lib/ui";
import { ProgressBar } from "../../components/ProgressBar";
import type { Prefs } from "../../hooks/usePrefs";
import type { Session } from "../../hooks/useSession";
import type { TimeRange } from "../../hooks/useTimeRange";
import { totalsOf } from "../workers/types";
import { useCostData } from "./useCostData";


/**
 * Billable-unit rollup across Workers and Workers AI for the shared window.
 *
 * This page reports UNITS, and multiplies them by rates the operator supplies. It does not ship
 * Cloudflare's list prices: they change, they differ by contract and region, and a stale number
 * rendered as "estimated cost" would be trusted far beyond what it deserves. With no rates
 * entered the page is a usage report, which is still the useful half.
 */
interface UnitRow {
	label: string;
	units: number;
	unitName: string;
	rateKey: keyof Prefs["costRates"] | null;
	/** How many rate-units this row's raw count represents (requests are priced per million). */
	perRate: number;
	source: string;
}

function formatUnits(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

export function CostPage({
	session,
	timeRange,
	prefs,
	updatePrefs,
	onAuthError,
}: {
	session: Session;
	timeRange: TimeRange;
	prefs: Prefs;
	updatePrefs: (patch: Partial<Prefs>) => void;
	onAuthError: () => void;
}) {
	const [reloadKey, setReloadKey] = useState(0);
	const { workers, ai, loading, error, progress, load } = useCostData(onAuthError);
	useSectionRefresh(useCallback(() => setReloadKey((k) => k + 1), []), loading);

	const granularity = timeRange.minutes > 7 * 24 * 60 ? "daily" : "hourly";
	const { from, to } = timeRange.bounds();

	useEffect(() => {
		load(session.token, session.accountId, from, to, granularity);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.token, session.accountId, timeRange.minutes, granularity, reloadKey, load]);

	const workerTotals = totalsOf(workers?.data ?? []);
	const rates = prefs.costRates;

	const rows: UnitRow[] = [
		{ label: "Worker requests", units: workerTotals.requests, unitName: "requests", rateKey: "requestsPerMillion", perRate: 1e6, source: "Workers Analytics" },
		{ label: "Worker subrequests", units: workerTotals.subrequests, unitName: "subrequests", rateKey: "subrequestsPerMillion", perRate: 1e6, source: "Workers Analytics" },
		{ label: "Workers AI neurons", units: ai?.totals.neurons ?? 0, unitName: "neurons", rateKey: "neuron", perRate: 1, source: "Workers AI" },
		{ label: "Workers AI tokens", units: (ai?.totals.inputTokens ?? 0) + (ai?.totals.outputTokens ?? 0), unitName: "tokens", rateKey: null, perRate: 1, source: "Workers AI" },
	];

	const costOf = (row: UnitRow): number | null => {
		if (!row.rateKey) return null;
		const rate = rates[row.rateKey];
		return rate > 0 ? (row.units / row.perRate) * rate : null;
	};
	const total = rows.reduce((sum, row) => sum + (costOf(row) ?? 0), 0);
	const anyRate = rows.some((row) => costOf(row) !== null);

	const rateInput = (label: string, key: keyof Prefs["costRates"], hint: string) => (
		<label className="flex flex-col gap-1 text-xs">
			<span className="text-zinc-500 dark:text-zinc-400">{label}</span>
			<input
				type="number"
				min={0}
				step="0.0001"
				value={rates[key] || ""}
				placeholder="0"
				onChange={(e) => updatePrefs({ costRates: { ...rates, [key]: Number(e.target.value) || 0 } })}
				className={`w-32 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm tabular-nums outline-none focus:border-cf dark:border-zinc-700 ${FOCUS_RING}`}
			/>
			<span className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
		</label>
	);

	return (
		<PageShell>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-xs text-zinc-500 dark:text-zinc-400">Billable units for the selected window</span>
			</div>

			{progress.running && <ProgressBar percent={progress.percent} />}

			{error && (
				<div role="alert" className={ALERT_ERROR}>
					{error}
				</div>
			)}

			<section className={`${CARD} p-0`}>
				<h2 className={CARD_HEADER}>Usage</h2>
				<table className="w-full text-sm">
					<thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
						<tr>
							<th className="px-4 py-2.5 text-left font-medium">Unit</th>
							<th className="px-4 py-2.5 text-right font-medium">Quantity</th>
							<th className="px-4 py-2.5 text-right font-medium">Your rate</th>
							<th className="px-4 py-2.5 text-right font-medium">Estimated</th>
							<th className="px-4 py-2.5 text-left font-medium">Source</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const cost = costOf(row);
							return (
								<tr key={row.label} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
									<td className="px-4 py-2.5">{row.label}</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{formatUnits(row.units)}</td>
									<td className="px-4 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
										{/* Two different absences, kept distinct: "no rate set" is the operator's to fix,
										    "no rate applies" is not. Both would read as one if they shared a glyph. */}
										{row.rateKey ? (rates[row.rateKey] || "—") : "no rate applies"}
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{cost === null ? "—" : cost.toFixed(2)}</td>
									<td className="px-4 py-2.5 text-xs text-zinc-500 dark:text-zinc-400">{row.source}</td>
								</tr>
							);
						})}
					</tbody>
					{anyRate && (
						<tfoot className="border-t border-zinc-200 text-sm font-semibold dark:border-zinc-800">
							<tr>
								<td className="px-4 py-2.5" colSpan={3}>Total at your rates</td>
								<td className="px-4 py-2.5 text-right tabular-nums">{total.toFixed(2)}</td>
								<td />
							</tr>
						</tfoot>
					)}
				</table>
			</section>

			<section className={CARD}>
				<h2 className={`mb-3 ${SECTION_TITLE}`}>Your rates</h2>
				<p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
					Stored in this browser only. No prices ship with the app — Cloudflare's change and differ per contract,
					so an estimate here is only ever as good as the numbers you put in. Currency is whatever you enter.
				</p>
				<div className="flex flex-wrap gap-4">
					{rateInput("Requests", "requestsPerMillion", "per million requests")}
					{rateInput("Subrequests", "subrequestsPerMillion", "per million subrequests")}
					{rateInput("Neurons", "neuron", "per neuron")}
				</div>
			</section>

			<p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
				Quantities come from the same sampled Cloudflare datasets as the Workers and Workers AI sections, so they are
				scaled estimates, not billing records. Always reconcile against your Cloudflare invoice.
			</p>
		</PageShell>
	);
}

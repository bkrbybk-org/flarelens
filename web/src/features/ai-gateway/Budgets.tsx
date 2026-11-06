import { useCallback, useState } from "react";
import { FOCUS_RING, MUTED } from "../../lib/ui";
import { storageGet, storageSet } from "../../lib/storage";
import { forecastMonth } from "./stack";
import { formatCost, formatRate } from "./types";

/**
 * Monthly budgets per user or tag value: the account budget's idea, one level down. Like it, a
 * budget is kept per account in this browser — a convenience, not shared state — and judged against
 * a forecast: the window's daily rate carried over the calendar month, not money actually billed.
 */

export interface BudgetRow {
	/** What the budget is stored under: the real name, whatever the screen shows. */
	id: string;
	kind: string;
	label: string;
	cost: number;
}

export type BudgetStatus = "over" | "on-track" | "unset";

export function budgetStatus(cost: number, budget: number | undefined, minutes: number): { status: BudgetStatus; forecast: number } {
	const forecast = forecastMonth(cost, minutes);
	return { forecast, status: !budget ? "unset" : forecast > budget ? "over" : "on-track" };
}

export function useBudgets(accountId: string) {
	const key = `flarelens_aig_budgets:${accountId}`;
	const [budgets, setBudgets] = useState<Record<string, number>>(() => {
		try {
			const parsed: unknown = JSON.parse(storageGet("local", key) ?? "{}");
			return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
		} catch {
			return {};
		}
	});
	const setBudget = useCallback(
		(id: string, text: string) => {
			setBudgets((prev) => {
				const next = { ...prev };
				if (Number(text) > 0) next[id] = Number(text);
				else delete next[id];
				storageSet("local", key, JSON.stringify(next));
				return next;
			});
		},
		[key],
	);
	return [budgets, setBudget] as const;
}

export function BudgetsPanel({
	rows,
	budgets,
	onBudget,
	minutes,
	sliced,
}: {
	rows: BudgetRow[];
	budgets: Record<string, number>;
	onBudget: (id: string, text: string) => void;
	minutes: number;
	sliced: boolean;
}) {
	if (!rows.length) return <p className={`text-xs ${MUTED}`}>No users or tag values with spend in this window. Pick a tag key under Breakdown to budget by team.</p>;
	return (
		<div className="overflow-x-auto text-xs">
			<table className="w-full text-left" aria-label="Budgets">
				<thead className={MUTED}>
					<tr>
						<th scope="col" className="py-1.5 pr-3 font-medium">Who</th>
						<th scope="col" className="py-1.5 pr-3 text-right font-medium">Spend in window</th>
						<th scope="col" className="py-1.5 pr-3 text-right font-medium">Forecast this month</th>
						<th scope="col" className="py-1.5 pr-3 font-medium">Monthly budget</th>
						<th scope="col" className="py-1.5 pr-3 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const budget = budgets[row.id];
						const { status, forecast } = budgetStatus(row.cost, budget, minutes);
						return (
							<tr key={row.id} className="border-t border-zinc-100 dark:border-zinc-800">
								<td className="py-1.5 pr-3">
									<span className={MUTED}>{row.kind} </span>
									<span className="font-medium">{row.label}</span>
								</td>
								<td className="py-1.5 pr-3 text-right tabular-nums">{formatCost(row.cost)}</td>
								<td className="py-1.5 pr-3 text-right tabular-nums">{formatCost(forecast)}</td>
								<td className="py-1.5 pr-3">
									<span className={MUTED}>$ </span>
									<input
										type="number"
										min="0"
										step="any"
										inputMode="decimal"
										aria-label={`Monthly budget for ${row.label}`}
										defaultValue={budget ?? ""}
										onChange={(e) => onBudget(row.id, e.target.value)}
										className={`w-20 rounded-md border border-zinc-200 bg-white px-2 py-1 tabular-nums dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`}
									/>
								</td>
								<td className={`py-1.5 pr-3 ${status === "over" ? "font-medium text-red-700 dark:text-red-400" : ""}`}>
									{status === "unset" ? <span className={MUTED}>—</span> : `${status === "over" ? "Over" : "On track"}: forecast ${formatRate(forecast / budget)} of budget`}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className={`mt-2 ${MUTED}`}>
				The forecast carries this window's daily rate over the calendar month: a projection, not a bill. Budgets are kept in this browser.
				{sliced && " You have drilled into a slice, so these figures cover only that part of each one's spend; judge a budget on the whole account."}
			</p>
		</div>
	);
}

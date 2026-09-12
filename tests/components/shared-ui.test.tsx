import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StatCard, StatGrid } from "../../web/src/components/StatCard";
import { EmptyNote, EmptyRow, EmptyState } from "../../web/src/components/EmptyState";

/**
 * The shared pieces that ended two design generations. These have no interesting behaviour, so
 * what is pinned here is the reason they exist: that there is exactly one of each, and that the
 * absences they render stay distinguishable from zeros.
 */

const WEB = join(import.meta.dirname, "..", "..", "web/src");

describe("StatCard", () => {
	it("formats a number so no call site has to remember to", () => {
		render(<StatCard label="Requests" value={1234567} />);
		expect(screen.getByText("1,234,567")).toBeInTheDocument();
	});

	it("leaves an already-formatted string alone", () => {
		// Percentages, currency and durations arrive formatted; re-formatting would corrupt them.
		render(<StatCard label="Hit ratio" value="98.4%" />);
		expect(screen.getByText("98.4%")).toBeInTheDocument();
	});

	it("renders a hint without it being mistaken for the value", () => {
		render(<StatCard label="Errors" value={0} hint="none in this window" />);
		expect(screen.getByText("0")).toBeInTheDocument();
		expect(screen.getByText("none in this window")).toBeInTheDocument();
	});
});

describe("empty states", () => {
	it("separates 'still loading' from 'nothing here'", () => {
		// A table that shows its empty message while fetching tells the reader something untrue.
		const { rerender } = render(<table><tbody><EmptyRow colSpan={3} title="No rules" loading /></tbody></table>);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByText("No rules")).not.toBeInTheDocument();

		rerender(<table><tbody><EmptyRow colSpan={3} title="No rules" /></tbody></table>);
		expect(screen.getByText("No rules")).toBeInTheDocument();
	});

	it("keeps the hint optional, so an absence with no actionable cause says only that", () => {
		render(<EmptyState title="No logins in this window" />);
		expect(screen.getByRole("heading", { name: "No logins in this window" })).toBeInTheDocument();
	});

	it("shows the hint when there is something the reader can act on", () => {
		render(<EmptyState title="No matching applications" hint="Try a different search or filter." />);
		expect(screen.getByText("Try a different search or filter.")).toBeInTheDocument();
	});
});

describe("one of each", () => {
	it("leaves no page defining its own stat card or empty state", () => {
		// The drift this replaced was five identical StatCard copies and four shapes of empty
		// state. A new copy would be invisible in review, so it fails here instead.
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) { walk(path); continue; }
				if (!entry.name.endsWith(".tsx")) continue;
				if (path.endsWith(join("components", "StatCard.tsx")) || path.endsWith(join("components", "EmptyState.tsx"))) continue;
				const source = readFileSync(path, "utf8");
				if (/function (StatCard|Kpi|EmptyState)\b/.test(source)) offenders.push(path);
			}
		};
		walk(WEB);
		expect(offenders).toEqual([]);
	});

	it("keeps StatGrid the only breakpoint for a row of stats", () => {
		// One section used to reflow at sm and xl while every other used lg, so on a tablet its
		// KPIs stacked differently from the rest of the app.
		const { container } = render(<StatGrid cols={5}><StatCard label="a" value={1} /></StatGrid>);
		expect(container.firstElementChild?.className).toBe("grid grid-cols-2 gap-3 lg:grid-cols-5");
	});
});

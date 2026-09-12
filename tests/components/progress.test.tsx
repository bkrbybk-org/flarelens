import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingVeil } from "../../web/src/components/LoadingVeil";
import { ProgressBar, progressLabel } from "../../web/src/components/ProgressBar";
import type { LoadProgress } from "../../web/src/hooks/useEstimatedProgress";

/**
 * The progress bar reports a time, which means it can be wrong in a way a bare animation cannot.
 * These pin the rule that keeps it honest: a countdown is only offered when it came from a real
 * measurement and is still ahead of the clock. Everything else is elapsed time, which is true
 * whatever happens.
 */

function progress(over: Partial<LoadProgress> = {}): LoadProgress {
	return {
		percent: 40, etaMs: 3000, elapsedMs: 2000, measured: true, running: true,
		start: () => {}, stop: () => {}, ...over,
	};
}

describe("progressLabel", () => {
	it("counts down when the estimate came from a previous load", () => {
		expect(progressLabel(progress({ etaMs: 3000 }))).toBe("About 3s remaining");
	});

	it("rounds the countdown up, so a moving bar never says zero", () => {
		expect(progressLabel(progress({ etaMs: 200 }))).toBe("About 1s remaining");
	});

	it("offers no countdown on the first load of a section", () => {
		// Nothing has been measured yet. The built-in 8s drives the curve but is not a
		// prediction, and showing it as one would be a number the app cannot stand behind.
		expect(progressLabel(progress({ measured: false, etaMs: null, elapsedMs: 4200 })))
			.toBe("Loading — 4s");
	});

	it("says so plainly once a load outruns its own estimate", () => {
		// The alternative is a countdown parked at 0s while the reader watches it not finish.
		expect(progressLabel(progress({ etaMs: null, elapsedMs: 12000 })))
			.toBe("Taking longer than usual — 12s so far");
	});

	it("reports completion rather than a time", () => {
		expect(progressLabel(progress({ percent: 100, etaMs: 0 }))).toBe("Done");
	});
});

describe("ProgressBar", () => {
	it("puts the wording where a screen reader reads it, not twice", () => {
		render(<ProgressBar progress={progress()} />);
		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuetext", "About 3s remaining");
		expect(bar).toHaveAttribute("aria-valuenow", "40");
		// The visible caption repeats it, so it is hidden from the accessibility tree.
		expect(screen.getByText("About 3s remaining")).toHaveAttribute("aria-hidden");
	});
});

describe("LoadingVeil", () => {
	it("dims the content but leaves it readable and interactive", () => {
		// The data on screen is the previous load's — real, about to be replaced. Fading says
		// "going stale"; removing or disabling it would take away something still useful.
		render(<LoadingVeil progress={progress()}><button type="button">Filter</button></LoadingVeil>);
		const region = screen.getByRole("button", { name: "Filter" }).parentElement!;
		expect(region.className).toContain("opacity-50");
		expect(region).toHaveAttribute("aria-busy", "true");
		expect(region.className).not.toContain("pointer-events-none");
	});

	it("keeps the progress bar out of the dimmed region", () => {
		// Fading the indicator along with the content it describes would be the opposite of
		// what it is for.
		render(<LoadingVeil progress={progress()}><p>rows</p></LoadingVeil>);
		const bar = screen.getByRole("progressbar");
		const dimmed = screen.getByText("rows").parentElement!;
		expect(dimmed.contains(bar)).toBe(false);
	});

	it("shows no bar and no dimming when nothing is loading", () => {
		render(<LoadingVeil progress={progress({ running: false })}><p>rows</p></LoadingVeil>);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.getByText("rows").parentElement!.className).toContain("opacity-100");
	});

	it("treats a section that reports no progress at all as idle", () => {
		render(<LoadingVeil progress={undefined}><p>rows</p></LoadingVeil>);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.getByText("rows").parentElement!).toHaveAttribute("aria-busy", "false");
	});
});

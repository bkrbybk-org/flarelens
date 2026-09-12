import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TabPanel, Tabs } from "../../web/src/components/Tabs";

/**
 * Two sections had hand-rolled tab strips that were half the ARIA pattern: the roles were there,
 * but nothing pointed at a panel and the arrow keys did nothing. A screen reader announced
 * "tab 1 of 2" and could not say what either tab led to. These pin the half that was missing.
 */

function Harness() {
	const [tab, setTab] = useState<"one" | "two">("one");
	return (
		<>
			<Tabs
				label="Views"
				idPrefix="t"
				active={tab}
				onChange={setTab}
				tabs={[{ id: "one", label: "First" }, { id: "two", label: "Second" }]}
			/>
			{tab === "one" ? (
				<TabPanel id="one" idPrefix="t">panel one</TabPanel>
			) : (
				<TabPanel id="two" idPrefix="t">panel two</TabPanel>
			)}
		</>
	);
}

describe("Tabs", () => {
	it("points each tab at the panel it controls", () => {
		render(<Harness />);
		const tab = screen.getByRole("tab", { name: "First" });
		const panel = screen.getByRole("tabpanel");
		expect(tab.getAttribute("aria-controls")).toBe(panel.id);
		expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
	});

	it("moves between tabs with the arrow keys", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole("tab", { name: "First" }));
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("panel two")).toBeInTheDocument();

		// Wraps, so End-of-strip is never a dead end.
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
	});

	it("keeps one tab in the tab order rather than all of them", async () => {
		// A roving tabindex is what the pattern requires, and it is why tabbing past a strip
		// costs one keypress instead of one per tab.
		render(<Harness />);
		expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("tabindex", "-1");
	});

	it("still selects on click, for everyone not using a keyboard", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<Tabs label="Views" idPrefix="t" active="one" onChange={onChange}
				tabs={[{ id: "one", label: "First" }, { id: "two", label: "Second" }]} />,
		);
		await user.click(screen.getByRole("tab", { name: "Second" }));
		expect(onChange).toHaveBeenCalledWith("two");
	});
});

describe("the sections that use it", () => {
	it("names its tablist, so the strip is not just 'tab list' out of context", () => {
		render(<Harness />);
		expect(screen.getByRole("tablist", { name: "Views" })).toBeInTheDocument();
	});
});

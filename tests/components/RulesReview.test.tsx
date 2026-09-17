import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RulesReview } from "../../web/src/features/waf/RulesReview";
import type { FirewallEvent, RuleMetaMap } from "../../web/src/lib/waf/types";

const rule = (id: string, rulesetId: string, ruleset: string, enabled = true) => ({
	name: `Rule ${id}`, ruleId: id, source: "zone", type: "custom", level: "zone",
	ruleset, rulesetName: ruleset, rulesetId, kind: "custom", action: "block", enabled, expression: "",
});

const meta: RuleMetaMap = {
	a1: rule("a1", "rs-a", "Custom A"),
	d1: { ...rule("d1", "rs-d", "default"), source: "zone:shop.example" },
	b1: rule("b1", "rs-b", "Custom B", false),
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}`, rule(`m${i}`, "rs-m", "Many rules")])),
};

const events: FirewallEvent[] = [
	{ ruleId: "a1", action: "block", clientRequestHTTPHost: "a.com", clientRequestPath: "/", datetime: new Date().toISOString(), source: "firewallCustom" },
];

function renderReview() {
	render(<RulesReview events={events} ruleMeta={meta} window={null} onSelectRule={vi.fn()} />);
}

describe("RulesReview grouped by ruleset", () => {
	it("renders one section per ruleset, busiest first", () => {
		renderReview();
		const sections = screen.getAllByRole("region");
		expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Custom A", "Custom B", "default (shop.example)", "Many rules"]);
		expect(within(sections[1]).getByText("1 disabled")).toBeInTheDocument();
		expect(screen.getByText("15 rules in 4 rulesets")).toBeInTheDocument();
	});

	it("collapses a group from its header and says so to assistive tech", async () => {
		const user = userEvent.setup();
		renderReview();
		const header = within(screen.getByRole("region", { name: "Custom A" })).getByRole("button", { expanded: true });
		await user.click(header);
		expect(header).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Rule a1")).toBeNull();
	});

	it("previews ten rules of a large ruleset and shows the rest on request", async () => {
		const user = userEvent.setup();
		renderReview();
		const many = screen.getByRole("region", { name: "Many rules" });
		expect(within(many).getAllByTitle("Open rule details")).toHaveLength(10);
		await user.click(within(many).getByRole("button", { name: "Show all 12 rules" }));
		expect(within(many).getAllByTitle("Open rule details")).toHaveLength(12);
	});

	it("drops rulesets with no rule matching the filter", async () => {
		const user = userEvent.setup();
		renderReview();
		await user.selectOptions(screen.getByLabelText("Filter by status"), "disabled");
		expect(screen.getAllByRole("region").map((s) => s.getAttribute("aria-label"))).toEqual(["Custom B"]);
	});
});

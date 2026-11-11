import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuleDrawer } from "../../web/src/features/waf/RuleDrawer";
import { RulesReview } from "../../web/src/features/waf/RulesReview";
import { ruleCountMap } from "../../web/src/lib/waf/aggregate";
import type { FirewallEvent, RuleMetaMap } from "../../web/src/lib/waf/types";

const meta: RuleMetaMap = {
	a1: {
		name: "Rule a1", ruleId: "a1", source: "zone", type: "custom", level: "zone",
		ruleset: "Custom A", rulesetName: "Custom A", rulesetId: "rs-a", kind: "custom", action: "block", enabled: true, expression: "",
	},
	q1: {
		name: "Quiet rule", ruleId: "q1", source: "zone", type: "custom", level: "zone",
		ruleset: "Custom A", rulesetName: "Custom A", rulesetId: "rs-a", kind: "custom", action: "block", enabled: true, expression: "",
	},
};
const events: FirewallEvent[] = [
	{ ruleId: "a1", action: "block", clientRequestHTTPHost: "a.com", clientRequestPath: "/login", datetime: new Date().toISOString() },
	{ ruleId: "a1", action: "block", clientRequestHTTPHost: "a.com", clientRequestPath: "/login", datetime: new Date().toISOString() },
];
const counts = ruleCountMap({
	byRule: [
		{ ruleId: "a1", action: "block", count: 1234 },
		{ ruleId: "q1", action: "block", count: 7 },
	],
});

describe("full per-rule counts on screen", () => {
	it("shows the drawer's full count and says the top lists are from the sample", () => {
		render(<RuleDrawer rule={{ id: "a1", name: "Rule a1" }} events={events} ruleMeta={meta} ruleCounts={counts} window={null} onClose={vi.fn()} />);
		expect(screen.getAllByText("1,234").length).toBeGreaterThan(0);
		expect(screen.getByText("Top lists from 2 sampled events.")).toBeInTheDocument();
		expect(screen.getByText("/login")).toBeInTheDocument();
	});

	it("says a rule that fired had no sampled event, rather than no events", () => {
		render(<RuleDrawer rule={{ id: "q1", name: "Quiet rule" }} events={events} ruleMeta={meta} ruleCounts={counts} window={null} onClose={vi.fn()} />);
		expect(screen.getAllByText("7").length).toBeGreaterThan(0);
		expect(screen.getByText(/None of this rule's events are in the sample/)).toBeInTheDocument();
		expect(screen.queryByText(/No events for this rule/)).not.toBeInTheDocument();
	});

	it("does not call a rule idle when only the full counts saw it fire", () => {
		render(<RulesReview events={events} ruleMeta={meta} ruleCounts={counts} window={null} onSelectRule={vi.fn()} />);
		expect(screen.getByText("not in the sample")).toBeInTheDocument();
		expect(screen.queryByText("no activity")).not.toBeInTheDocument();
	});
});

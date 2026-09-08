import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupsPage } from "../../web/src/features/access/GroupsPage";
import type { CfApp, CfGroup, CfPolicy } from "../../web/src/types";
import type { RuleContext } from "../../web/src/lib/rules";

/**
 * The Access Groups section shows two kinds of account-level configuration that applications
 * attach by reference: the rule groups themselves, and the reusable policies that reference
 * them. Neither is visible on the Applications page, so both need to be reachable here.
 */

const ctx: RuleContext = { idpNames: {}, groupNames: {} };

const group: CfGroup = { id: "g1", name: "Engineering", include: [{ email_domain: { domain: "example.com" } }] };

const policies: CfPolicy[] = [
	{ id: "p1", name: "Staff only", decision: "allow", include: [{ everyone: {} }] },
	{ id: "p2", name: "Old vendor access", decision: "allow", include: [{ everyone: {} }] },
];

const apps: CfApp[] = [
	{ id: "a1", name: "wiki", domain: "wiki.example.com", policies: [{ id: "p1" }] } as unknown as CfApp,
];

function renderPage(overrides: Partial<Parameters<typeof GroupsPage>[0]> = {}) {
	return render(
		<GroupsPage
			groups={[group]}
			groupsError={false}
			apps={apps}
			reusableMap={{ p1: policies[0], p2: policies[1] }}
			reusablePolicies={policies}
			reusablePoliciesError={false}
			loading={false}
			error={null}
			progressPercent={0}
			progressRunning={false}
			ctx={ctx}
			{...overrides}
		/>,
	);
}

afterEach(() => {
	window.location.hash = "";
});

describe("GroupsPage tabs", () => {
	it("opens on reusable policies, with rule groups one click away", async () => {
		// Policies lead: they are what applications actually attach, and a rule group is only
		// reachable through one.
		renderPage();
		expect(screen.getByRole("tab", { name: /Reusable policies \(2\)/ })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Staff only")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: /Rule groups \(1\)/ }));
		expect(screen.getByText("Engineering")).toBeInTheDocument();
		// The policies panel is replaced, not merely hidden behind it.
		expect(screen.queryByText("Staff only")).not.toBeInTheDocument();
	});

	it("names the applications attaching a policy, and flags one attaching nothing", async () => {
		// An unattached reusable policy enforces nothing. That is either dead configuration or a
		// policy someone believes is in force, and both are worth seeing.
		renderPage();
		expect(screen.getByText("wiki")).toBeInTheDocument();
		expect(screen.getByText("Not attached")).toBeInTheDocument();
	});

	it("sorts by last update, newest first, without being asked", async () => {
		// This page is for review, so the thing that moved last is the thing worth looking at.
		renderPage({
			reusablePolicies: [
				{ id: "old", name: "Older policy", decision: "allow", updated_at: "2026-01-01T00:00:00Z" },
				{ id: "new", name: "Newer policy", decision: "allow", updated_at: "2026-09-01T00:00:00Z" },
			],
		});
		const names = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
		expect(names[0]).toContain("Newer policy");
		expect(names[1]).toContain("Older policy");
	});

	it("expands a row to show its rules", async () => {
		renderPage();
		expect(screen.queryByText(/Raw JSON/i)).not.toBeInTheDocument();
		await userEvent.click(screen.getByText("Staff only"));
		expect(screen.getByText(/Raw JSON/i)).toBeInTheDocument();
	});

	it("filters the table by search", async () => {
		renderPage();
		await userEvent.type(screen.getByRole("searchbox"), "vendor");

		expect(screen.getByText("Old vendor access")).toBeInTheDocument();
		expect(screen.queryByText("Staff only")).not.toBeInTheDocument();
	});

	it("distinguishes a missing permission from an account with no reusable policies", async () => {
		// The two produce an identical empty list, and only one of them is the operator's to fix.
		const { unmount } = renderPage({ reusablePolicies: [], reusablePoliciesError: true });
		expect(screen.getByText(/API token is missing/)).toBeInTheDocument();
		unmount();

		renderPage({ reusablePolicies: [], reusablePoliciesError: false });
		expect(screen.getByText(/defines no reusable policies/)).toBeInTheDocument();
	});

	it("mirrors the active tab into the hash so the view is deep-linkable", async () => {
		renderPage();
		await userEvent.click(screen.getByRole("tab", { name: /Rule groups/ }));
		expect(window.location.hash).toContain("tab=groups");
	});
});

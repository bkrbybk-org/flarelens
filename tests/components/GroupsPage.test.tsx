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
	it("opens on rule groups, with reusable policies one click away", async () => {
		renderPage();
		expect(screen.getByRole("tab", { name: /Rule groups \(1\)/ })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Engineering")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies \(2\)/ }));
		expect(screen.getByText("Staff only")).toBeInTheDocument();
		// The groups panel is replaced, not merely hidden behind it.
		expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
	});

	it("says which applications attach a policy, and says when none do", async () => {
		// An unattached reusable policy enforces nothing. That is either dead configuration or a
		// policy someone believes is in force, and both are worth seeing.
		renderPage();
		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies/ }));

		expect(screen.getByText(/Attached to 1 application:/)).toBeInTheDocument();
		expect(screen.getByText("wiki")).toBeInTheDocument();
		expect(screen.getByText(/Not attached to any application/)).toBeInTheDocument();
	});

	it("searches within the active tab", async () => {
		renderPage();
		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies/ }));
		await userEvent.type(screen.getByRole("searchbox"), "vendor");

		expect(screen.getByText("Old vendor access")).toBeInTheDocument();
		expect(screen.queryByText("Staff only")).not.toBeInTheDocument();
	});

	it("distinguishes a missing permission from an account with no reusable policies", async () => {
		// The two produce an identical empty list, and only one of them is the operator's to fix.
		const { unmount } = renderPage({ reusablePolicies: [], reusablePoliciesError: true });
		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies/ }));
		expect(screen.getByText(/API token is missing/)).toBeInTheDocument();
		unmount();

		renderPage({ reusablePolicies: [], reusablePoliciesError: false });
		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies/ }));
		expect(screen.getByText(/defines no reusable policies/)).toBeInTheDocument();
	});

	it("mirrors the active tab into the hash so the view is deep-linkable", async () => {
		renderPage();
		await userEvent.click(screen.getByRole("tab", { name: /Reusable policies/ }));
		expect(window.location.hash).toContain("tab=policies");
	});
});

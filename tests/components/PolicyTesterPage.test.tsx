import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PolicyTesterPage } from "../../web/src/features/access/PolicyTesterPage";
import type { LoadProgress } from "../../web/src/hooks/useEstimatedProgress";
import type { CfApp } from "../../web/src/types";

const progress: LoadProgress = { percent: 100, etaMs: null, elapsedMs: 0, measured: false, running: false, start: () => {}, stop: () => {} };
const ctx = { groupName: (id: string) => id, idpName: (id: string) => id };

const apps: CfApp[] = [
	{
		id: "app1",
		name: "GitLab",
		domain: "gitlab.example.com",
		policies_error: false,
		policies: [
			{ id: "p-block", name: "Block contractors", decision: "deny", precedence: 1, include: [{ email_domain: { domain: "contractor.example" } }] },
			{ id: "p-allow", name: "Staff", decision: "allow", precedence: 2, include: [{ email_domain: { domain: "example.com" } }] },
		],
	},
];

function renderPage() {
	render(<PolicyTesterPage apps={apps} groups={[]} lists={[]} idps={[]} reusableMap={{}} ctx={ctx} loading={false} error={null} progress={progress} />);
}

describe("PolicyTesterPage", () => {
	it("gives a verdict and names the deciding policy", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.selectOptions(screen.getByLabelText("Application"), "app1");
		await user.type(screen.getByLabelText("Email"), "dev@example.com");
		expect(screen.getByText("Allowed")).toBeInTheDocument();
		expect(screen.getByText("decides").closest("li")).toHaveTextContent("Staff");
	});

	it("lets an earlier Block win", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.selectOptions(screen.getByLabelText("Application"), "app1");
		await user.type(screen.getByLabelText("Email"), "x@contractor.example");
		expect(screen.getByText("Blocked")).toBeInTheDocument();
	});

	it("says it cannot tell before anything is entered, rather than guessing", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.selectOptions(screen.getByLabelText("Application"), "app1");
		expect(screen.getByText("Depends")).toBeInTheDocument();
	});
});

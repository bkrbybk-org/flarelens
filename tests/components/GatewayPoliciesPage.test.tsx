import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GatewayPoliciesPage } from "../../web/src/features/gateway-policies/GatewayPoliciesPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { GwReport } from "../../web/src/features/gateway-policies/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary, same as ZoneHealthPage.test.tsx — the component, the hook, and
// the render are all exercised for real; only the network call is faked.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchGatewayPoliciesReport: vi.fn() };
});

import { fetchGatewayPoliciesReport } from "../../web/src/api/client";

const mockedFetch = vi.mocked(fetchGatewayPoliciesReport);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

const EMPTY_STAGES: GwReport["stages"] = [
	{ stage: { id: "dns_resolver", label: "DNS resolver policies", detail: "d" }, rules: [] },
	{ stage: { id: "dns", label: "DNS policies", detail: "d" }, rules: [] },
	{ stage: { id: "l4", label: "Network (L4) policies", detail: "d" }, rules: [] },
	{ stage: { id: "http", label: "HTTP policies", detail: "d" }, rules: [] },
];

function baseReport(overrides: Partial<GwReport> = {}): GwReport {
	return {
		rules: overrides.rules ?? [],
		stages: overrides.stages ?? EMPTY_STAGES,
		findings: overrides.findings ?? [],
		totals: overrides.totals ?? { rules: 0, enabled: 0, disabled: 0, byType: { dns: 0, http: 0, l4: 0, dns_resolver: 0 } },
	};
}

async function renderPage(result: GwReport) {
	mockedFetch.mockResolvedValue({ result, cachedAt: null });
	render(<GatewayPoliciesPage session={session} onAuthError={vi.fn()} />);
}

beforeEach(() => {
	mockedFetch.mockReset();
	sessionStorage.clear();
	window.location.hash = "";
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GatewayPoliciesPage", () => {
	it("shows KPI totals from the report", async () => {
		const result = baseReport({ totals: { rules: 5, enabled: 4, disabled: 1, byType: { dns: 2, http: 2, l4: 1, dns_resolver: 0 } } });
		await renderPage(result);

		expect(await screen.findByText("5")).toBeInTheDocument();
		expect(screen.getByText("Rules")).toBeInTheDocument();
	});

	it("renders a rule inside its enforcement stage, with position, action and never-runs badge", async () => {
		const result = baseReport({
			rules: [
				{
					id: "r1",
					name: "Block earlier",
					description: "",
					precedence: 1,
					enabled: true,
					action: "block",
					filterType: "http",
					filters: ["http"],
					traffic: "true",
					identity: "",
					devicePosture: "",
					untrustedCertAction: null,
					updatedAt: null,
				},
				{
					id: "r2",
					name: "Never runs",
					description: "",
					precedence: 2,
					enabled: true,
					action: "allow",
					filterType: "http",
					filters: ["http"],
					traffic: "",
					identity: "",
					devicePosture: "",
					untrustedCertAction: null,
					updatedAt: null,
				},
			],
			stages: [
				...EMPTY_STAGES.filter((s) => s.stage.id !== "http"),
				{
					stage: { id: "http", label: "HTTP policies", detail: "d" },
					rules: [
						{ rule: { id: "r1", name: "Block earlier", description: "", precedence: 1, enabled: true, action: "block", filterType: "http", filters: ["http"], traffic: "true", identity: "", devicePosture: "", untrustedCertAction: null, updatedAt: null }, position: 1, terminating: true },
						{ rule: { id: "r2", name: "Never runs", description: "", precedence: 2, enabled: true, action: "allow", filterType: "http", filters: ["http"], traffic: "", identity: "", devicePosture: "", untrustedCertAction: null, updatedAt: null }, position: 2, terminating: true, shadowedBy: { id: "r1", name: "Block earlier" } },
					],
				},
			],
			findings: [{ severity: "medium", ruleId: "r2", ruleName: "Never runs", filterType: "http", title: "Rule never runs", detail: "shadowed" }],
			totals: { rules: 2, enabled: 2, disabled: 0, byType: { dns: 0, http: 2, l4: 0, dns_resolver: 0 } },
		});
		await renderPage(result);

		expect(await screen.findByText("Block earlier")).toBeInTheDocument();
		// "Never runs" appears twice: the victim rule's own name, and the badge on its row.
		expect(screen.getAllByText("Never runs").length).toBeGreaterThanOrEqual(2);
	});

	it("shows the findings list, sorted by severity", async () => {
		const result = baseReport({
			findings: [
				{ severity: "low", ruleId: "r1", ruleName: "Off rule", filterType: "http", title: "Do Not Inspect rule", detail: "bypasses inspection" },
				{ severity: "medium", ruleId: "r2", ruleName: "Allow rule", filterType: "http", title: "Allow rule with no identity condition", detail: "anyone matching traffic is allowed" },
			],
		});
		await renderPage(result);

		const mediumBadge = await screen.findByText("medium");
		const lowBadge = screen.getByText("low");
		expect(mediumBadge.compareDocumentPosition(lowBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows an empty state for findings when there are none", async () => {
		await renderPage(baseReport());
		expect(await screen.findByText("No findings")).toBeInTheDocument();
	});

	it("renders a report-level error instead of swallowing it", async () => {
		mockedFetch.mockRejectedValue(new Error("Failed to build the Gateway Policies report"));
		render(<GatewayPoliciesPage session={session} onAuthError={vi.fn()} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to build the Gateway Policies report");
	});
});

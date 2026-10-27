import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhyBlockedPage } from "../../web/src/features/why/WhyBlockedPage";
import type { Session } from "../../web/src/hooks/useSession";
import type * as ApiClientModule from "../../web/src/api/client";

vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, traceRequest: vi.fn(), fetchWafRulesets: vi.fn() };
});
import { fetchWafRulesets, traceRequest } from "../../web/src/api/client";

const session: Session = { token: "", accountId: "acc1", accountName: "Acme", mode: "server" };
const meta = {
	root: { name: "default", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", isRuleset: true },
	allow: { name: "Allow office", ruleId: "allow", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", action: "skip", enabled: true, expression: "ip.src in {192.0.2.0/24}", position: 0 },
	geo: { name: "Geography-based rule", ruleId: "geo", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", action: "block", enabled: true, expression: 'ip.src.country in {"CN"}', position: 1 },
	after: { name: "Block bad paths", ruleId: "after", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", action: "block", enabled: true, expression: "x", position: 2 },
};

beforeEach(() => {
	history.replaceState(null, "", "#/why");
	vi.mocked(traceRequest).mockResolvedValue({
		foundIn: { id: "z1", name: "example.com" },
		request: { securityAction: "block", securitySource: "firewallCustom", edgeResponseStatus: 403, clientRequestHTTPMethodName: "GET", clientRequestHTTPHost: "example.com", clientRequestPath: "/" },
		firewallEvents: [{ ruleId: "geo", rulesetId: "root", action: "block", source: "firewallCustom", description: "Geography-based rule", matchIndex: 0 }],
		zonesSearched: [{ id: "z1", name: "example.com" }],
		errors: [],
	});
	vi.mocked(fetchWafRulesets).mockResolvedValue({ result: meta, cachedAt: null } as never);
});

describe("WhyBlockedPage", () => {
	it("names the blocking rule and shows it in order, with what came after not reached", async () => {
		const user = userEvent.setup();
		render(<WhyBlockedPage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "a511938d1a0dd949-BKK");
		await user.click(screen.getByRole("button", { name: "Explain" }));
		expect(await screen.findByText('Block by "Geography-based rule"')).toBeInTheDocument();
		expect(fetchWafRulesets).toHaveBeenCalledWith("", "acc1", "z1");
		expect(screen.getByText("Block — evaluation stopped here")).toBeInTheDocument();
		expect(screen.getByText("Block bad paths").closest("li")).toHaveTextContent("not reached");
		expect(location.hash).toContain("ray=a511938d1a0dd949-BKK");
	});

	it("says so when the Ray ID is not found, without asking for rulesets", async () => {
		vi.mocked(traceRequest).mockResolvedValue({ firewallEvents: [], zonesSearched: [], errors: [] });
		const user = userEvent.setup();
		render(<WhyBlockedPage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "0000000000000000");
		await user.click(screen.getByRole("button", { name: "Explain" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("No request with this Ray ID was found");
		expect(fetchWafRulesets).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestTracePage } from "../../web/src/features/request/RequestTracePage";
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
	history.replaceState(null, "", "#/request");
	vi.mocked(traceRequest).mockResolvedValue({
		rayId: "a511938d1a0dd949",
		window: { since: "2026-10-20T00:00:00Z", until: "2026-10-27T00:00:00Z" },
		unavailableFields: [],
		extraFields: [],
		droppedFields: [],
		foundIn: { id: "z1", name: "example.com" },
		request: { botScore: 92, securityAction: "block", securitySource: "firewallCustom", edgeResponseStatus: 403, clientRequestHTTPMethodName: "GET", clientRequestHTTPHost: "example.com", clientRequestPath: "/" },
		firewallEvents: [{ ruleId: "geo", rulesetId: "root", action: "block", source: "firewallCustom", description: "Geography-based rule", matchIndex: 0 }],
		zonesSearched: [{ id: "z1", name: "example.com" }],
		errors: [],
	});
	vi.mocked(fetchWafRulesets).mockResolvedValue({ result: meta, cachedAt: null } as never);
});

describe("RequestTracePage", () => {
	it("names the blocking rule and shows it in order, with what came after not reached", async () => {
		const user = userEvent.setup();
		render(<RequestTracePage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "a511938d1a0dd949-BKK");
		await user.click(screen.getByRole("button", { name: "Investigate" }));
		expect(await screen.findByText('Block by "Geography-based rule"')).toBeInTheDocument();
		expect(fetchWafRulesets).toHaveBeenCalledWith("", "acc1", "z1");
		expect(screen.getByText("Block — evaluation stopped here")).toBeInTheDocument();
		expect(screen.getByText("Block bad paths").closest("li")).toHaveTextContent("not reached");
		expect(location.hash).toContain("ray=a511938d1a0dd949-BKK");
		// The false-positive review: the scores say human, and the draft narrows the deciding rule.
		expect(screen.getByText(/likely a false positive/)).toBeInTheDocument();
		expect(screen.getByText('(ip.src.country in {"CN"}) and not (http.host eq "example.com" and http.request.uri.path eq "/")')).toBeInTheDocument();
		// The request record is on the same page.
		expect(screen.getByRole("heading", { name: "Firewall events (1)" })).toBeInTheDocument();
	});

	it("still shows the request when the WAF rules can't be read", async () => {
		vi.mocked(fetchWafRulesets).mockRejectedValue(new Error("Missing Zone WAF: Read"));
		const user = userEvent.setup();
		render(<RequestTracePage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "a511938d1a0dd949");
		await user.click(screen.getByRole("button", { name: "Investigate" }));
		expect(await screen.findByText(/WAF rules could not be read/)).toHaveTextContent("Missing Zone WAF: Read");
		expect(screen.getByRole("heading", { name: "Firewall events (1)" })).toBeInTheDocument();
	});

	it("says the Ray ID was not found, without asking for rulesets", async () => {
		vi.mocked(traceRequest).mockResolvedValue({ window: { since: "2026-10-20T00:00:00Z" }, firewallEvents: [], zonesSearched: [], errors: [] });
		const user = userEvent.setup();
		render(<RequestTracePage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "0000000000000000");
		await user.click(screen.getByRole("button", { name: "Investigate" }));
		expect(await screen.findByText("No matching request in this window")).toBeInTheDocument();
		expect(fetchWafRulesets).not.toHaveBeenCalled();
	});

	it("does not call a logged request blocked", async () => {
		vi.mocked(traceRequest).mockResolvedValue({
			rayId: "a51198c5d9cf8941",
			unavailableFields: [],
			foundIn: { id: "z1", name: "example.com" },
			request: { securityAction: "log", securitySource: "firewallManaged", edgeResponseStatus: 200 },
			firewallEvents: [{ ruleId: "after", rulesetId: "root", action: "log", source: "firewallCustom", description: "Block bad paths", matchIndex: 0 }],
			zonesSearched: [],
			errors: [],
		});
		const user = userEvent.setup();
		render(<RequestTracePage session={session} zones={[]} onAuthError={vi.fn()} />);
		await user.type(screen.getByLabelText("Ray ID"), "a51198c5d9cf8941");
		await user.click(screen.getByRole("button", { name: "Investigate" }));
		expect(await screen.findByText("Not blocked or challenged — 1 rule only logged or skipped it")).toBeInTheDocument();
		expect(screen.getByText("Let through — is this a false negative?")).toBeInTheDocument();
		expect(screen.getByText(/"Block bad paths" .* matched but only did "log"/)).toBeInTheDocument();
	});
});

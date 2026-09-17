import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotsPage } from "../../web/src/features/bots/BotsPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { RatelimitBotResult } from "../../web/src/features/bots/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary, same as ZoneHealthPage.test.tsx.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchBotsReport: vi.fn() };
});

import { fetchBotsReport } from "../../web/src/api/client";

const mockedFetch = vi.mocked(fetchBotsReport);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

function emptyResult(over: Partial<RatelimitBotResult> = {}): RatelimitBotResult {
	return {
		rateLimit: [],
		botManagement: [],
		findings: [],
		totals: { zonesChecked: 0, rateLimitRules: 0, zonesWithNoRateLimitRules: 0, botProtectionOn: 0, botProtectionOff: 0, botProtectionUnknown: 0 },
		...over,
	};
}

async function renderPage(result: RatelimitBotResult) {
	mockedFetch.mockResolvedValue({ result, cachedAt: null });
	render(<BotsPage session={session} zoneId="" onAuthError={vi.fn()} />);
}

beforeEach(() => {
	mockedFetch.mockReset();
	sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BotsPage", () => {
	it("shows KPI totals from the report", async () => {
		await renderPage(
			emptyResult({
				totals: { zonesChecked: 3, rateLimitRules: 5, zonesWithNoRateLimitRules: 1, botProtectionOn: 2, botProtectionOff: 1, botProtectionUnknown: 0 },
			}),
		);
		expect(await screen.findByText("3")).toBeInTheDocument();
		expect(screen.getByText("5")).toBeInTheDocument();
	});

	it("renders a rate-limit rule row with action, characteristics and threshold", async () => {
		await renderPage(
			emptyResult({
				rateLimit: [
					{
						scope: "zone",
						zoneId: "z1",
						zoneName: "example.com",
						status: "ok",
						rules: [
							{
								ruleId: "r1",
								description: "Login throttle",
								enabled: true,
								action: "block",
								expression: 'http.request.uri.path eq "/login"',
								ratelimit: { characteristics: ["ip.src"], period: 60, requestsPerPeriod: 100 },
							},
						],
					},
				],
			}),
		);
		expect(await screen.findByText("Login throttle")).toBeInTheDocument();
		expect(screen.getByText("100 req / 60s")).toBeInTheDocument();
		expect(screen.getByText("ip.src")).toBeInTheDocument();
	});

	it("shows a rate-limit scope as not checked, with its reason, rather than an empty list", async () => {
		await renderPage(
			emptyResult({
				rateLimit: [{ scope: "zone", zoneId: "z1", zoneName: "example.com", status: "unknown", reason: "Not checked — missing permission: nope", rules: [] }],
			}),
		);
		expect(await screen.findByText(/not checked/)).toBeInTheDocument();
		expect(screen.getByText(/missing permission/)).toBeInTheDocument();
	});

	it("switches to the Bot settings tab and shows plan tier and settings badges", async () => {
		const user = userEvent.setup();
		await renderPage(
			emptyResult({
				botManagement: [
					{ zoneId: "z1", zoneName: "example.com", status: "ok", planTier: "bot_fight_mode", settings: { fight_mode: true, enable_js: false } },
				],
			}),
		);
		await user.click(await screen.findByRole("tab", { name: "Bot settings" }));
		expect(await screen.findByText("Bot Fight Mode")).toBeInTheDocument();
		expect(screen.getByText("example.com")).toBeInTheDocument();
	});

	it("shows a bot management zone as not checked when its read failed", async () => {
		const user = userEvent.setup();
		await renderPage(
			emptyResult({
				botManagement: [{ zoneId: "z1", zoneName: "example.com", status: "unknown", reason: "Not checked — missing permission: nope", planTier: "unknown", settings: {} }],
			}),
		);
		await user.click(await screen.findByRole("tab", { name: "Bot settings" }));
		expect(await screen.findByText(/Not checked/)).toBeInTheDocument();
	});

	it("switches to the Findings tab and lists findings with severity", async () => {
		const user = userEvent.setup();
		await renderPage(
			emptyResult({
				findings: [{ severity: "high", zoneId: "z1", zoneName: "example.com", title: "Bot protection is off", detail: "Neither Bot Fight Mode nor SBFM is enabled." }],
			}),
		);
		await user.click(await screen.findByRole("tab", { name: "Findings" }));
		expect(await screen.findByText("Bot protection is off")).toBeInTheDocument();
		expect(screen.getByText("high")).toBeInTheDocument();
	});

	it("renders an error instead of swallowing it", async () => {
		mockedFetch.mockRejectedValue(new Error("Forbidden"));
		render(<BotsPage session={session} zoneId="" onAuthError={vi.fn()} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
	});
});

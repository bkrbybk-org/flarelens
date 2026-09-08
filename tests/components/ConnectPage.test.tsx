import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectPage } from "../../web/src/components/connect/ConnectPage";
import type * as ApiClientModule from "../../web/src/api/client";

vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchAccounts: vi.fn(), fetchZeroTrustData: vi.fn() };
});

import { fetchAccounts, fetchZeroTrustData } from "../../web/src/api/client";

const mockedFetchAccounts = vi.mocked(fetchAccounts);
const mockedFetchZeroTrustData = vi.mocked(fetchZeroTrustData);

beforeEach(() => {
	mockedFetchAccounts.mockReset();
	mockedFetchZeroTrustData.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ConnectPage", () => {
	it("shows 'API Token is required' and calls no fetch when submitted with an empty token", () => {
		render(<ConnectPage onConnect={vi.fn()} />);

		// The token <input> carries `required`, so jsdom's own constraint validation would
		// swallow a real button click before React's onSubmit ever runs. Dispatching the
		// submit event directly exercises the component's own empty-token guard instead of
		// the browser's, which is the thing this test is protecting.
		const form = screen.getByLabelText("Cloudflare API Token").closest("form")!;
		fireEvent.submit(form);

		expect(screen.getByRole("alert")).toHaveTextContent("API Token is required");
		expect(mockedFetchAccounts).not.toHaveBeenCalled();
		expect(mockedFetchZeroTrustData).not.toHaveBeenCalled();
	});

	it("lists every required permission entry", () => {
		render(<ConnectPage onConnect={vi.fn()} />);

		expect(screen.getByText("Account Settings: Read")).toBeInTheDocument();
		expect(screen.getByText("Lists the accounts your token can access.")).toBeInTheDocument();
		expect(screen.getByText("Access: Read")).toBeInTheDocument();
		expect(screen.getByText("Applications, policies, and identity providers.")).toBeInTheDocument();
	});

	it("lists every optional permission entry", () => {
		render(<ConnectPage onConnect={vi.fn()} />);

		expect(screen.getByText("Zone: Read")).toBeInTheDocument();
		expect(screen.getByText("Account WAF: Read")).toBeInTheDocument();
		expect(screen.getByText("Zone WAF: Read")).toBeInTheDocument();
		expect(screen.getByText("Cache Rules: Read")).toBeInTheDocument();
		expect(screen.getByText("Zone Analytics: Read")).toBeInTheDocument();
		expect(screen.getByText("Analytics: Read")).toBeInTheDocument();
		expect(screen.getByText("Cloudflare Tunnel: Read")).toBeInTheDocument();
		expect(screen.getByText("Workers Scripts: Read")).toBeInTheDocument();
		expect(
			screen.getByText("Resolves group names inside policies and populates the Access Groups section."),
		).toBeInTheDocument();
	});
});

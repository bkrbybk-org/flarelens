import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PqcPage } from "../../web/src/features/pqc/PqcPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { PqcResult } from "../../web/src/features/pqc/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary — the same boundary usePqcReport calls through — so the
// component, the hook, the filter/search logic and the render are all exercised for real, and
// only the network is faked. No test in this file touches fetch.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchPqcReport: vi.fn() };
});

import { fetchPqcReport } from "../../web/src/api/client";

const mockedFetchPqcReport = vi.mocked(fetchPqcReport);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

function zone(overrides: Partial<PqcResult["zones"][number]>): PqcResult["zones"][number] {
	return {
		zoneId: overrides.zoneId ?? "z",
		zoneName: overrides.zoneName ?? "zone",
		tls13: "on",
		minTlsVersion: "1.2",
		sslMode: "strict",
		ciphers: { mode: "default", suites: [], counts: {} as never, findings: [], supersededByTls13: true },
		tlsFindings: [],
		hostnames: 0,
		ready: 0,
		eligible: 0,
		notReady: 0,
		unknown: 0,
		...overrides,
	};
}

const REPORT: PqcResult = {
	rows: [
		{
			zoneId: "z1",
			zoneName: "example.com",
			fqdn: "www.example.com",
			type: "A",
			proxied: true,
			inbound: "pqc",
			origin: "tunnel",
			verdict: "ready",
			reasons: [],
		},
		{
			zoneId: "z1",
			zoneName: "example.com",
			fqdn: "api.example.com",
			type: "A",
			proxied: false,
			inbound: "not-proxied",
			origin: "unknown",
			verdict: "not-ready",
			reasons: ["DNS-only — not terminated by Cloudflare"],
		},
		{
			zoneId: "z2",
			zoneName: "other.net",
			fqdn: "shop.other.net",
			type: "CNAME",
			proxied: true,
			inbound: "pqc",
			origin: "eligible",
			verdict: "eligible",
			reasons: [],
		},
	],
	zones: [
		zone({ zoneId: "z1", zoneName: "example.com", hostnames: 2, ready: 1, notReady: 1 }),
		zone({ zoneId: "z2", zoneName: "other.net", hostnames: 1, eligible: 1 }),
		zone({ zoneId: "z3", zoneName: "broken.org", tls13: null, sslMode: null, error: "Zone Settings: Read scope missing" }),
	],
	totals: { hostnames: 3, ready: 1, eligible: 1, notReady: 1, unknown: 0, tlsFindings: 0 },
	errors: [{ source: "broken.org", message: "Zone Settings: Read scope missing" }],
	tunnelsKnown: true,
	workersKnown: true,
};

async function renderPage() {
	render(<PqcPage session={session} onAuthError={vi.fn()} />);
	// Wait for the mocked report to land before asserting on rendered rows.
	await screen.findByText("www.example.com");
}

beforeEach(() => {
	mockedFetchPqcReport.mockReset();
	mockedFetchPqcReport.mockResolvedValue(REPORT);
	sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PqcPage", () => {
	it("renders every hostname row from the report by default", async () => {
		await renderPage();
		expect(screen.getByText("www.example.com")).toBeInTheDocument();
		expect(screen.getByText("api.example.com")).toBeInTheDocument();
		expect(screen.getByText("shop.other.net")).toBeInTheDocument();
	});

	it("narrows to only the matching rows when a verdict filter chip is clicked", async () => {
		const user = userEvent.setup();
		await renderPage();

		await user.click(screen.getByRole("button", { name: "Not ready" }));

		expect(screen.getByText("api.example.com")).toBeInTheDocument();
		expect(screen.queryByText("www.example.com")).not.toBeInTheDocument();
		expect(screen.queryByText("shop.other.net")).not.toBeInTheDocument();
	});

	it("restores every row when the All filter chip is clicked again", async () => {
		const user = userEvent.setup();
		await renderPage();

		await user.click(screen.getByRole("button", { name: "Not ready" }));
		await user.click(screen.getByRole("button", { name: "All" }));

		expect(screen.getByText("www.example.com")).toBeInTheDocument();
		expect(screen.getByText("api.example.com")).toBeInTheDocument();
		expect(screen.getByText("shop.other.net")).toBeInTheDocument();
	});

	it("filters rows by hostname text typed into the search box", async () => {
		const user = userEvent.setup();
		await renderPage();

		await user.type(screen.getByLabelText("Search hostnames"), "www");

		expect(screen.getByText("www.example.com")).toBeInTheDocument();
		expect(screen.queryByText("api.example.com")).not.toBeInTheDocument();
		expect(screen.queryByText("shop.other.net")).not.toBeInTheDocument();
	});

	it("filters rows by zone name typed into the search box", async () => {
		const user = userEvent.setup();
		await renderPage();

		await user.type(screen.getByLabelText("Search hostnames"), "other.net");

		expect(screen.getByText("shop.other.net")).toBeInTheDocument();
		expect(screen.queryByText("www.example.com")).not.toBeInTheDocument();
		expect(screen.queryByText("api.example.com")).not.toBeInTheDocument();
	});

	// A zone that failed to load (missing scope, upstream error, etc.) must be reported to the
	// operator, not silently dropped from the report — see PqcPage's `result?.errors.map`.
	it("renders a zone-level error instead of swallowing it", async () => {
		await renderPage();
		const statuses = screen.getAllByRole("status");
		const errorStatus = statuses.find((el) => el.textContent?.includes("broken.org"));
		expect(errorStatus).toHaveTextContent("broken.org: Zone Settings: Read scope missing");
	});

	it("shows the empty state when a filter matches no rows", async () => {
		const user = userEvent.setup();
		await renderPage();

		await user.type(screen.getByLabelText("Search hostnames"), "nothing-matches-this");

		expect(screen.getByText("Nothing to show for this filter.")).toBeInTheDocument();
		expect(screen.queryByText("www.example.com")).not.toBeInTheDocument();
	});
});

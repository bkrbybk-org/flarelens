import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoneHealthPage } from "../../web/src/features/zone-health/ZoneHealthPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { ZoneHealthResult } from "../../web/src/features/zone-health/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary, same as PqcPage.test.tsx — the component, the hook, and the
// render are all exercised for real; only the network call is faked.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchZoneHealthReport: vi.fn() };
});

import { fetchZoneHealthReport } from "../../web/src/api/client";

const mockedFetch = vi.mocked(fetchZoneHealthReport);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

const CLEAN_SOURCE = { available: true as const, items: [] };

function zone(overrides: Partial<ZoneHealthResult["zones"][number]> = {}): ZoneHealthResult["zones"][number] {
	return {
		zoneId: overrides.zoneId ?? "z1",
		zoneName: overrides.zoneName ?? "example.com",
		certificates: overrides.certificates ?? { edge: CLEAN_SOURCE, custom: CLEAN_SOURCE, originCa: CLEAN_SOURCE },
		dns: overrides.dns ?? { findings: [], unknown: [], checked: { records: 0, cnamesResolved: 0, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 } },
	};
}

async function renderPage(result: ZoneHealthResult) {
	mockedFetch.mockResolvedValue({ result, cachedAt: null });
	render(<ZoneHealthPage session={session} onAuthError={vi.fn()} />);
}

beforeEach(() => {
	mockedFetch.mockReset();
	sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ZoneHealthPage", () => {
	it("shows a certificate source as not checked, with its reason, rather than an empty list", async () => {
		const result: ZoneHealthResult = {
			zones: [
				zone({
					certificates: {
						edge: { available: false, reason: 'Needs "SSL and Certificates: Read" — the bound token is not authorized.', items: [] },
						custom: CLEAN_SOURCE,
						originCa: CLEAN_SOURCE,
					},
				}),
			],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 1 },
			errors: [],
		};
		await renderPage(result);

		expect(await screen.findByText(/not checked/)).toBeInTheDocument();
		expect(screen.getByText(/SSL and Certificates: Read/)).toBeInTheDocument();
	});

	it("states the number of records checked when DNS hygiene is clean, so checked-clean differs from not-checked", async () => {
		const result: ZoneHealthResult = {
			zones: [zone({ dns: { findings: [], unknown: [], checked: { records: 42, cnamesResolved: 3, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 } } })],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 0 },
			errors: [],
		};
		await renderPage(result);

		expect(await screen.findByText(/No findings in 42 DNS records checked across 1 zone\./)).toBeInTheDocument();
	});

	it("renders DNS findings sorted high to low with severity, record and detail", async () => {
		const result: ZoneHealthResult = {
			zones: [
				zone({
					dns: {
						findings: [
							{ severity: "low", record: { name: "dup.example.com", type: "TXT", content: "v=spf1" }, title: "Duplicate DNS record", detail: "2 identical records." },
							{
								severity: "high",
								record: { name: "gone.example.com", type: "CNAME", content: "dead.example.net" },
								title: "Dangling external CNAME",
								detail: "dead.example.net does not exist — subdomain takeover risk.",
							},
						],
						unknown: [],
						checked: { records: 2, cnamesResolved: 1, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
					},
				}),
			],
			totals: { zones: 1, findings: { high: 1, medium: 0, low: 1 }, unknown: 0 },
			errors: [],
		};
		await renderPage(result);

		const highCell = await screen.findByText("high");
		const rows = highCell.closest("tr")?.parentElement?.querySelectorAll("tr") ?? [];
		expect(rows[0].textContent).toContain("high");
		expect(screen.getByText("Dangling external CNAME")).toBeInTheDocument();
	});

	it("lists unknown DNS checks separately from findings, with their reason", async () => {
		const result: ZoneHealthResult = {
			zones: [
				zone({
					dns: {
						findings: [],
						unknown: [{ record: { name: "app.example.com", type: "CNAME", content: "abc.cfargotunnel.com" }, reason: "Tunnel list came back empty." }],
						checked: { records: 1, cnamesResolved: 0, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
					},
				}),
			],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 1 },
			errors: [],
		};
		await renderPage(result);

		expect(await screen.findByText("Unable to check")).toBeInTheDocument();
		expect(screen.getByText("Tunnel list came back empty.")).toBeInTheDocument();
	});

	it("renders a report-level error instead of swallowing it", async () => {
		const result: ZoneHealthResult = {
			zones: [zone()],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 0 },
			errors: [{ source: "tunnels", message: "Forbidden" }],
		};
		await renderPage(result);

		const statuses = await screen.findAllByRole("status");
		expect(statuses.some((el) => el.textContent?.includes("tunnels: Forbidden"))).toBe(true);
	});

	it("does not call DNS clean without saying what could not be checked", async () => {
		// Some lookups failing is not the same as everything passing. The empty state has to carry
		// the unchecked count in the same sentence, or a partly unread zone reads as a clean one.
		const result: ZoneHealthResult = {
			zones: [
				zone({
					dns: {
						findings: [],
						unknown: [{ record: { name: "app.example.com", type: "CNAME", content: "x.azurewebsites.net" }, reason: "DNS-over-HTTPS lookup timed out" }],
						checked: { records: 10, cnamesResolved: 1, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
					},
				}),
			],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 1 },
			errors: [],
		};
		await renderPage(result);

		expect(await screen.findByText(/No findings in 10 DNS records checked.*1 could not be checked — listed below, not counted as clean\./)).toBeInTheDocument();
		expect(screen.getByText("DNS-over-HTTPS lookup timed out")).toBeInTheDocument();
	});

	it("says nothing was checked when every DNS read failed, rather than reporting zero findings", async () => {
		const result: ZoneHealthResult = {
			zones: [
				zone({
					dns: {
						findings: [],
						unknown: [{ record: { name: "*", type: "*", content: "" }, reason: "DNS records could not be read: Authentication error" }],
						checked: { records: 0, cnamesResolved: 0, cnamesSkippedByCap: 0, validationCnamesSkipped: 0 },
					},
				}),
			],
			totals: { zones: 1, findings: { high: 0, medium: 0, low: 0 }, unknown: 1 },
			errors: [],
		};
		await renderPage(result);

		expect(await screen.findByText(/No DNS records could be checked/)).toBeInTheDocument();
		expect(screen.queryByText(/No findings in/)).not.toBeInTheDocument();
	});
});

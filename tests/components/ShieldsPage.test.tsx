import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShieldsPage } from "../../web/src/features/shields/ShieldsPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { ShieldsResult, ZoneShields } from "../../web/src/features/shields/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary, same as DnsPage.test.tsx — the component, the hook, and the
// render are all exercised for real; only the network calls are faked.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchShieldsReport: vi.fn(), fetchZones: vi.fn() };
});

import { fetchShieldsReport, fetchZones } from "../../web/src/api/client";

const mockedFetch = vi.mocked(fetchShieldsReport);
const mockedZones = vi.mocked(fetchZones);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

function zone(overrides: Partial<ZoneShields> = {}): ZoneShields {
	return {
		zoneId: "z1",
		zoneName: "example.com",
		pageShield: {
			status: { available: true, enabled: true, updatedAt: null, useCloudflareReportingEndpoint: true, useConnectionUrlPath: false },
			scripts: {
				available: true,
				totalSeen: 1,
				truncated: false,
				items: [
					{
						id: "s1", url: "https://cdn.example.net/a.js", host: "cdn.example.net", addedAt: null,
						firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-18T00:00:00Z", firstPageUrl: null, pageUrls: ["/"],
						status: "active", domainReportedMalicious: false, maliciousDomainCategories: null, urlReportedMalicious: null,
						maliciousUrlCategories: null, urlContainsCdnCgiPath: false, versionsCount: 1, thirdParty: true, newThirdParty: false,
					},
				],
			},
			connections: { available: true, items: [], truncated: false, totalSeen: 0 },
			policies: { available: true, items: [] },
		},
		apiShield: {
			operations: { available: false, reason: 'Needs "API Gateway: Read" — the bound token is not authorized to read this on this zone.', savedCount: 0 },
			discovery: { available: false, reason: 'Needs "API Gateway: Read" — the bound token is not authorized to read this on this zone.', discoveredNotSavedCount: 0 },
			schemaValidation: { available: false, reason: 'Needs "API Gateway: Read" — the bound token is not authorized to read this on this zone.', defaultAction: null, perOperationOverrideCount: null },
			userSchemas: { available: false, reason: 'Needs "API Gateway: Read" — the bound token is not authorized to read this on this zone.', count: 0 },
			configuration: { available: false, reason: 'Needs "API Gateway: Read" — the bound token is not authorized to read this on this zone.', sessionIdentifierConfigured: false, sessionIdentifierCount: 0 },
			fullyChecked: false,
		},
		...overrides,
	};
}

function result(overrides: Partial<ShieldsResult> = {}): ShieldsResult {
	const zones = overrides.zones ?? [zone()];
	return {
		zones,
		findings: overrides.findings ?? [],
		totals: overrides.totals ?? {
			zones: zones.length,
			pageShieldEnabledZones: zones.filter((z) => z.pageShield.status.available && z.pageShield.status.enabled).length,
			scripts: zones.reduce((s, z) => s + (z.pageShield.scripts.available ? z.pageShield.scripts.totalSeen : 0), 0),
			connections: zones.reduce((s, z) => s + (z.pageShield.connections.available ? z.pageShield.connections.totalSeen : 0), 0),
			maliciousFlags: 0,
			apiShieldCheckedZones: zones.filter((z) => z.apiShield.fullyChecked).length,
			apiShieldNotCheckedZones: zones.filter((z) => !z.apiShield.fullyChecked).length,
			findings: { high: 0, medium: 0, low: 0, info: 0 },
		},
		errors: overrides.errors ?? [],
	};
}

async function renderPage(res: ShieldsResult) {
	mockedFetch.mockResolvedValue({ result: res, cachedAt: null });
	mockedZones.mockResolvedValue({ result: [{ id: "z1", name: "example.com" }], cachedAt: null });
	render(<ShieldsPage session={session} onAuthError={vi.fn()} />);
}

beforeEach(() => {
	mockedFetch.mockReset();
	mockedZones.mockReset();
	sessionStorage.clear();
	window.location.hash = "";
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ShieldsPage", () => {
	it("renders Page Shield data and shows API Shield as not checked, never as zero", async () => {
		await renderPage(result());

		// KPI row
		expect(await screen.findByText("Page Shield on")).toBeInTheDocument();
		expect(screen.getByText("0/1")).toBeInTheDocument(); // API Shield checked KPI

		// Page Shield tab: the third-party script from the fixture is visible by default.
		expect(screen.getByText("cdn.example.net")).toBeInTheDocument();
		expect(screen.getByText("third-party")).toBeInTheDocument();

		// Switch to the API Shield tab: every read must say "not checked", never a bare 0.
		const tab = screen.getByRole("tab", { name: "API Shield" });
		tab.click();
		const notChecked = await screen.findAllByText(/Not checked —/);
		expect(notChecked.length).toBeGreaterThan(0);
		expect(screen.getAllByText(/API Gateway: Read/).length).toBeGreaterThan(0);
	});

	it("renders a malicious flag as a high-severity finding, not folded into the total silently", async () => {
		const flagged = zone({
			pageShield: {
				...zone().pageShield,
				scripts: {
					available: true,
					totalSeen: 1,
					truncated: false,
					items: [
						{
							id: "s2", url: "https://evil.example.net/x.js", host: "evil.example.net", addedAt: null,
							firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-09-18T00:00:00Z", firstPageUrl: null, pageUrls: [],
							status: "active", domainReportedMalicious: true, maliciousDomainCategories: ["malware"], urlReportedMalicious: null,
							maliciousUrlCategories: null, urlContainsCdnCgiPath: false, versionsCount: 1, thirdParty: true, newThirdParty: false,
						},
					],
				},
			},
		});
		const res = result({
			zones: [flagged],
			findings: [
				{
					severity: "high",
					zoneId: "z1",
					zoneName: "example.com",
					source: "page-shield",
					title: "Malicious script or connection flagged",
					detail: "evil.example.net — malware",
				},
			],
			totals: { ...result().totals, maliciousFlags: 1, findings: { high: 1, medium: 0, low: 0, info: 0 } },
		});
		await renderPage(res);

		expect(await screen.findByText("Findings (1)")).toBeInTheDocument();
		screen.getByRole("tab", { name: /Findings/ }).click();
		expect(await screen.findByText("Malicious script or connection flagged")).toBeInTheDocument();
		expect(screen.getByText("high")).toBeInTheDocument();
	});
});

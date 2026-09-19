import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FindingsPage } from "../../web/src/features/findings/FindingsPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { LoadProgress } from "../../web/src/hooks/useEstimatedProgress";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary — the same boundary useFindingsSources calls through — so the
// component, the hook and the render are all exercised for real; only the network is faked.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return {
		...actual,
		fetchTunnelMap: vi.fn(),
		fetchZoneHealthReport: vi.fn(),
		fetchPqcReport: vi.fn(),
		fetchDnsRecords: vi.fn(),
		fetchBotsReport: vi.fn(),
	};
});

import { ApiError, fetchBotsReport, fetchDnsRecords, fetchPqcReport, fetchTunnelMap, fetchZoneHealthReport } from "../../web/src/api/client";

const mocks = {
	tunnels: vi.mocked(fetchTunnelMap),
	zoneHealth: vi.mocked(fetchZoneHealthReport),
	pqc: vi.mocked(fetchPqcReport),
	dns: vi.mocked(fetchDnsRecords),
	bots: vi.mocked(fetchBotsReport),
};

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

const progress: LoadProgress = {
	percent: 100, etaMs: null, elapsedMs: 0, measured: false, running: false, start: () => {}, stop: () => {},
};

const EMPTY_TUNNELS = { tunnels: [], rows: [], privateRoutes: [], errors: [] };
const EMPTY_ZONE_HEALTH = { zones: [], totals: { zones: 0, findings: { high: 0, medium: 0, low: 0 }, unknown: 0 }, errors: [] };
const EMPTY_PQC = { rows: [], zones: [], totals: { hostnames: 0, ready: 0, eligible: 0, notReady: 0, unknown: 0, tlsFindings: 0, validationRecordsExcluded: 0 }, errors: [], tunnelsKnown: true, workersKnown: true };
const EMPTY_DNS = { rows: [], summary: { totalRecords: 0, proxiedCount: 0, dnsOnlyCount: 0, exposedOriginCount: 0, byType: {}, byZone: [] }, zoneErrors: [] };
const EMPTY_BOTS = { rateLimit: [], botManagement: [], findings: [], totals: { zonesChecked: 0, rateLimitRules: 0, zonesWithNoRateLimitRules: 0, botProtectionOn: 0, botProtectionOff: 0, botProtectionUnknown: 0 } };

function renderPage(onAuthError = vi.fn()) {
	return render(
		<FindingsPage
			session={session}
			apps={[]}
			groups={[]}
			reusableMap={{}}
			loading={false}
			error={null}
			progress={progress}
			onNavigate={() => {}}
			onAuthError={onAuthError}
		/>,
	);
}

describe("FindingsPage per-source status", () => {
	beforeEach(() => {
		mocks.tunnels.mockReset();
		mocks.zoneHealth.mockReset();
		mocks.pqc.mockReset();
		mocks.dns.mockReset();
		mocks.bots.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows loading, then checked with a count, for a source that resolves", async () => {
		mocks.tunnels.mockResolvedValue({ result: EMPTY_TUNNELS, cachedAt: null });
		mocks.zoneHealth.mockResolvedValue({ result: EMPTY_ZONE_HEALTH, cachedAt: null });
		mocks.pqc.mockResolvedValue({ result: EMPTY_PQC, cachedAt: null });
		mocks.dns.mockResolvedValue({
			result: {
				...EMPTY_DNS,
				rows: [{ zoneId: "z1", zoneName: "example.com", id: "r1", type: "A", name: "origin.example.com", content: "203.0.113.5", proxied: false, proxiable: true, ttl: 1, comment: null, tags: [], modified_on: null, flags: ["origin-exposed"] }],
			},
			cachedAt: null,
		});
		mocks.bots.mockResolvedValue({ result: EMPTY_BOTS, cachedAt: null });

		renderPage();

		expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);

		await waitFor(() => expect(screen.getAllByText(/DNS Records/).length).toBeGreaterThan(0));
		await waitFor(() => expect(screen.getByText(/checked \(1 finding\)/)).toBeInTheDocument());
		expect(screen.getAllByText(/checked \(0 findings\)/).length).toBeGreaterThan(0);
	});

	it("reports a fetch failure as not checked, with a reason, never as clean", async () => {
		mocks.tunnels.mockResolvedValue({ result: EMPTY_TUNNELS, cachedAt: null });
		mocks.zoneHealth.mockResolvedValue({ result: EMPTY_ZONE_HEALTH, cachedAt: null });
		mocks.pqc.mockRejectedValue(new Error("network down"));
		mocks.dns.mockResolvedValue({ result: EMPTY_DNS, cachedAt: null });
		mocks.bots.mockResolvedValue({ result: EMPTY_BOTS, cachedAt: null });

		renderPage();

		await waitFor(() => expect(screen.getByText(/Fetch failed: network down/)).toBeInTheDocument());
		expect(screen.getAllByText(/not checked/i).length).toBeGreaterThan(0);
	});

	it("reports a 403 as a named permission gap and escalates to the auth handler", async () => {
		const onAuthError = vi.fn();
		mocks.tunnels.mockResolvedValue({ result: EMPTY_TUNNELS, cachedAt: null });
		mocks.zoneHealth.mockRejectedValue(new ApiError("Forbidden", 403));
		mocks.pqc.mockResolvedValue({ result: EMPTY_PQC, cachedAt: null });
		mocks.dns.mockResolvedValue({ result: EMPTY_DNS, cachedAt: null });
		mocks.bots.mockResolvedValue({ result: EMPTY_BOTS, cachedAt: null });

		renderPage(onAuthError);

		await waitFor(() => expect(screen.getByText(/Permission missing/)).toBeInTheDocument());
		expect(onAuthError).toHaveBeenCalled();
	});

	it("shows WAF and Cache as not opened until their own pages have published a snapshot", async () => {
		mocks.tunnels.mockResolvedValue({ result: EMPTY_TUNNELS, cachedAt: null });
		mocks.zoneHealth.mockResolvedValue({ result: EMPTY_ZONE_HEALTH, cachedAt: null });
		mocks.pqc.mockResolvedValue({ result: EMPTY_PQC, cachedAt: null });
		mocks.dns.mockResolvedValue({ result: EMPTY_DNS, cachedAt: null });
		mocks.bots.mockResolvedValue({ result: EMPTY_BOTS, cachedAt: null });

		renderPage();

		await waitFor(() => expect(screen.getAllByText(/not opened/).length).toBe(2));
	});
});

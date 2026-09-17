import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DnsPage } from "../../web/src/features/dns/DnsPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { DnsRecordsResult, DnsRow } from "../../web/src/features/dns/types";
import type * as ApiClientModule from "../../web/src/api/client";

// Mock at the api/client boundary, same as ZoneHealthPage.test.tsx — the component, the hook, and
// the render are all exercised for real; only the network call is faked.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchDnsRecords: vi.fn() };
});

import { fetchDnsRecords } from "../../web/src/api/client";

const mockedFetch = vi.mocked(fetchDnsRecords);

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

function row(overrides: Partial<DnsRow> = {}): DnsRow {
	return {
		zoneId: "z1",
		zoneName: "example.com",
		id: "r1",
		type: "A",
		name: "www.example.com",
		content: "203.0.113.10",
		proxied: true,
		proxiable: true,
		ttl: 1,
		comment: null,
		tags: [],
		modified_on: "2026-01-01T00:00:00Z",
		flags: [],
		...overrides,
	};
}

function result(overrides: Partial<DnsRecordsResult> = {}): DnsRecordsResult {
	const rows = overrides.rows ?? [row()];
	return {
		rows,
		summary: overrides.summary ?? {
			totalRecords: rows.length,
			proxiedCount: rows.filter((r) => r.proxied).length,
			dnsOnlyCount: rows.filter((r) => !r.proxied).length,
			exposedOriginCount: rows.filter((r) => r.flags.includes("origin-exposed")).length,
			byType: {},
			byZone: [],
		},
		zoneErrors: overrides.zoneErrors ?? [],
	};
}

async function renderPage(res: DnsRecordsResult) {
	mockedFetch.mockResolvedValue({ result: res, cachedAt: null });
	render(<DnsPage session={session} onAuthError={vi.fn()} />);
}

beforeEach(() => {
	mockedFetch.mockReset();
	sessionStorage.clear();
	window.location.hash = "";
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DnsPage", () => {
	it("renders a DNS record row with zone, name and content", async () => {
		await renderPage(result({ rows: [row({ name: "api.example.com", content: "198.51.100.5" })] }));
		expect(await screen.findByText("api.example.com")).toBeInTheDocument();
		expect(screen.getByText("198.51.100.5")).toBeInTheDocument();
		expect(screen.getAllByText("example.com").length).toBeGreaterThan(0);
	});

	it("renders TTL 1 as Auto, never as 1s", async () => {
		await renderPage(result({ rows: [row({ ttl: 1 })] }));
		expect(await screen.findByText("Auto")).toBeInTheDocument();
		expect(screen.queryByText("1s")).not.toBeInTheDocument();
	});

	it("renders a real TTL in seconds", async () => {
		await renderPage(result({ rows: [row({ ttl: 300 })] }));
		expect(await screen.findByText("300s")).toBeInTheDocument();
	});

	it("shows the origin-exposed flag on a flagged row", async () => {
		await renderPage(result({ rows: [row({ flags: ["origin-exposed"], proxied: false })] }));
		expect(await screen.findByText("origin exposed")).toBeInTheDocument();
	});

	it("lists a per-zone error instead of swallowing it", async () => {
		await renderPage(result({ zoneErrors: [{ zoneId: "z2", zoneName: "broken.example", reason: "Forbidden" }] }));
		const statuses = await screen.findAllByRole("status");
		expect(statuses.some((el) => el.textContent?.includes("broken.example: Forbidden"))).toBe(true);
	});

	it("filters rows by search text", async () => {
		await renderPage(
			result({
				rows: [row({ id: "r1", name: "api.example.com" }), row({ id: "r2", name: "www.example.com", content: "198.51.100.9" })],
			}),
		);
		await screen.findByText("api.example.com");
		const user = userEvent.setup();
		const search = screen.getByLabelText("Search DNS records");
		await user.type(search, "www");
		expect(screen.queryByText("api.example.com")).not.toBeInTheDocument();
		expect(screen.getByText("www.example.com")).toBeInTheDocument();
	});

	it("shows an empty state when there are no records", async () => {
		await renderPage(result({ rows: [] }));
		expect(await screen.findByText("No DNS records found")).toBeInTheDocument();
	});
});

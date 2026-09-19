import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TunnelDrawer } from "../../web/src/features/tunnels/TunnelDrawer";
import type { LatestCloudflared, MappingRow, TunnelConnector, TunnelSummary } from "../../web/src/features/tunnels/types";

const connector = (id: string, version: string, pending = 0): TunnelConnector => ({
	id, version, arch: "linux_amd64", startedAt: "2026-09-01T00:00:00Z", features: ["management_logs"],
	connections: Array.from({ length: 4 }, (_, i) => ({
		id: `${id}-${i}`, colo: i % 2 ? "sin16" : "sin18", openedAt: "2026-09-15T00:00:00Z", originIp: "203.0.113.7", pendingReconnect: i < pending,
	})),
});

const tunnel = (over: Partial<TunnelSummary> = {}): TunnelSummary => ({
	id: "t-1", name: "Tunnel A", status: "healthy", colos: ["sin16", "sin18"], configSource: "cloudflare",
	activeSince: "2026-09-01T00:00:00Z", connectors: [connector("aaaaaaaa-1", "2026.6.0"), connector("bbbbbbbb-2", "2026.6.1", 1)],
	health: [{ level: "warn", message: "Connector bbbbbbbb has a connection waiting to reconnect." }],
	...over,
});

const rows: MappingRow[] = [
	{ hostname: "app.example.com", service: "https://10.0.0.5:443", originKind: "tunnel", tunnel: { id: "t-1", name: "Tunnel A", status: "healthy" } },
	{ hostname: "other.example.com", service: "http://x", originKind: "tunnel", tunnel: { id: "t-2", name: "B", status: "healthy" } },
];

function renderDrawer(over: Partial<Parameters<typeof TunnelDrawer>[0]> = {}) {
	return render(
		<TunnelDrawer
			tunnel={tunnel()}
			rows={rows}
			privateRoutes={[]}
			token="tok"
			accountId="acct"
			onClose={vi.fn()}
			{...over}
		/>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TunnelDrawer", () => {
	it("lists each connector with its version, connection count and connections", () => {
		renderDrawer();
		const dialog = screen.getByRole("dialog", { name: "Details for tunnel Tunnel A" });
		expect(within(dialog).getByText("Connectors (2)")).toBeInTheDocument();
		expect(within(dialog).getByText("4/4 connections")).toBeInTheDocument();
		expect(within(dialog).getByText("3/4 connections")).toBeInTheDocument();
		expect(within(dialog).getAllByText("reconnecting")).toHaveLength(1);
		expect(within(dialog).getByText("cloudflared 2026.6.0")).toHaveAttribute("title", "Differs from another connector on this tunnel");
		expect(within(dialog).getByText("Connector bbbbbbbb has a connection waiting to reconnect.")).toBeInTheDocument();
	});

	it("shows only the hostnames this tunnel serves", () => {
		renderDrawer();
		expect(screen.getByText("app.example.com")).toBeInTheDocument();
		expect(screen.queryByText("other.example.com")).toBeNull();
	});

	it("says a connectors failure is not the same as none running", () => {
		renderDrawer({ tunnel: tunnel({ connectors: [], connectorsError: "Authentication error", health: [] }), rows: [] });
		expect(screen.getByText(/Connectors could not be read: Authentication error/)).toBeInTheDocument();
		expect(screen.queryByText(/No cloudflared connector is running/)).toBeNull();
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		renderDrawer({ rows: [], onClose });
		await userEvent.setup().keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("shows the latest release next to a connector's version badge when it is behind", () => {
		const latest: LatestCloudflared = { version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" };
		renderDrawer({ latestCloudflared: latest });
		expect(screen.getAllByText("(latest: 2026.9.1)").length).toBeGreaterThan(0);
	});

	it("does not show a latest badge when the connector is already current", () => {
		const latest: LatestCloudflared = { version: "2026.6.1", publishedAt: "2026-06-01T00:00:00Z" };
		renderDrawer({ tunnel: tunnel({ connectors: [connector("aaaaaaaa-1", "2026.6.1")] }), latestCloudflared: latest });
		expect(screen.queryByText(/latest:/)).toBeNull();
	});

	describe("connector metrics", () => {
		it("explains there is no target configured, with a README pointer, when hasMetricsTarget is falsy", () => {
			renderDrawer({ tunnel: tunnel({ hasMetricsTarget: false }) });
			expect(screen.getByText(/has no metrics target configured/)).toBeInTheDocument();
			expect(screen.getByText(/README's "Connector metrics" setup section/)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Load metrics" })).toBeNull();
		});

		it("shows a Load metrics button when a target is configured, and loads on click", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					new Response(
						JSON.stringify({
							success: true,
							result: {
								metrics: { processResidentMemoryBytes: 52428800, haConnections: 4, totalRequests: 120, requestErrors: 2, concurrentRequests: 1 },
								fetchedAt: "2026-09-19T12:00:00Z",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				),
			);
			renderDrawer({ tunnel: tunnel({ hasMetricsTarget: true }) });
			await userEvent.setup().click(screen.getByRole("button", { name: "Load metrics" }));
			await waitFor(() => expect(screen.getByText("50.0 MiB")).toBeInTheDocument());
			expect(screen.getByText("120 / 2")).toBeInTheDocument();
		});

		it("shows the stated error reason when the fetch fails", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					new Response(JSON.stringify({ success: false, errors: [{ message: "The metrics endpoint did not respond in time." }] }), {
						status: 502,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);
			renderDrawer({ tunnel: tunnel({ hasMetricsTarget: true }) });
			await userEvent.setup().click(screen.getByRole("button", { name: "Load metrics" }));
			await waitFor(() => expect(screen.getByText("The metrics endpoint did not respond in time.")).toBeInTheDocument());
		});
	});
});

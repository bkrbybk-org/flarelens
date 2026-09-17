import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TunnelDrawer } from "../../web/src/features/tunnels/TunnelDrawer";
import type { MappingRow, TunnelConnector, TunnelSummary } from "../../web/src/features/tunnels/types";

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

describe("TunnelDrawer", () => {
	it("lists each connector with its version, connection count and connections", () => {
		render(<TunnelDrawer tunnel={tunnel()} rows={rows} privateRoutes={[]} onClose={vi.fn()} />);
		const dialog = screen.getByRole("dialog", { name: "Details for tunnel Tunnel A" });
		expect(within(dialog).getByText("Connectors (2)")).toBeInTheDocument();
		expect(within(dialog).getByText("4/4 connections")).toBeInTheDocument();
		expect(within(dialog).getByText("3/4 connections")).toBeInTheDocument();
		expect(within(dialog).getAllByText("reconnecting")).toHaveLength(1);
		expect(within(dialog).getByText("cloudflared 2026.6.0")).toHaveAttribute("title", "Differs from another connector on this tunnel");
		expect(within(dialog).getByText("Connector bbbbbbbb has a connection waiting to reconnect.")).toBeInTheDocument();
		expect(within(dialog).getByText(/CPU and memory are not reported/)).toBeInTheDocument();
	});

	it("shows only the hostnames this tunnel serves", () => {
		render(<TunnelDrawer tunnel={tunnel()} rows={rows} privateRoutes={[]} onClose={vi.fn()} />);
		expect(screen.getByText("app.example.com")).toBeInTheDocument();
		expect(screen.queryByText("other.example.com")).toBeNull();
	});

	it("says a connectors failure is not the same as none running", () => {
		render(<TunnelDrawer tunnel={tunnel({ connectors: [], connectorsError: "Authentication error", health: [] })} rows={[]} privateRoutes={[]} onClose={vi.fn()} />);
		expect(screen.getByText(/Connectors could not be read: Authentication error/)).toBeInTheDocument();
		expect(screen.queryByText(/No cloudflared connector is running/)).toBeNull();
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(<TunnelDrawer tunnel={tunnel()} rows={[]} privateRoutes={[]} onClose={onClose} />);
		await userEvent.setup().keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});
});

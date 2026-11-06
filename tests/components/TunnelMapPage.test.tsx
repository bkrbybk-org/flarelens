import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TunnelMapPage } from "../../web/src/features/tunnels/TunnelMapPage";
import type { MappingRow, TunnelMapResult } from "../../web/src/features/tunnels/types";
import type { Session } from "../../web/src/hooks/useSession";
import type * as ApiClientModule from "../../web/src/api/client";

// Faked at the api/client boundary so the hook and the real list rendering both run.
vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchTunnelMap: vi.fn() };
});

import { fetchTunnelMap } from "../../web/src/api/client";

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };

const appRow = (over: Partial<MappingRow>, id: string, name: string): MappingRow => ({
	hostname: "team.example.com",
	service: "Cloudflare-hosted",
	originKind: "cloudflare",
	app: { id, name, type: "warp", policies: [], policiesError: false },
	...over,
});

const RESULT: TunnelMapResult = {
	tunnels: [],
	privateRoutes: [],
	errors: [],
	rows: [
		appRow({}, "app-launcher", "Launcher"),
		appRow({}, "app-warp", "WARP login"),
		appRow({}, "app-biso", "Isolation"),
		appRow({ hostname: "tool.example.com", service: "Worker: tool", originKind: "worker" }, "app-admin", "Admin"),
		appRow({ hostname: "tool.example.com", service: "Worker: tool", originKind: "worker" }, "app-api", "API"),
	],
};

describe("TunnelMapPage rows", () => {
	beforeEach(() => {
		vi.mocked(fetchTunnelMap).mockResolvedValue({ result: RESULT, cachedAt: null });
	});
	afterEach(() => vi.restoreAllMocks());

	it("renders apps sharing a hostname as separate rows without a duplicate key", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TunnelMapPage session={session} onAuthError={vi.fn()} />);

		const heading = await screen.findByRole("heading", { name: /Destination → application/ });
		const list = within(heading.parentElement as HTMLElement);
		for (const name of ["Launcher", "WARP login", "Isolation", "Admin", "API"]) {
			expect(await list.findByText(name)).toBeInTheDocument();
		}
		expect(list.getAllByRole("listitem")).toHaveLength(RESULT.rows.length);

		const duplicateKeyErrors = consoleError.mock.calls.filter((args) => String(args[0]).includes("same key"));
		expect(duplicateKeyErrors).toEqual([]);
	});
});

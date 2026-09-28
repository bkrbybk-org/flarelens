import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuditLogPage } from "../../web/src/features/audit/AuditLogPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { TimeRange } from "../../web/src/hooks/useTimeRange";
import type { AuditEvent, AuditLogResult } from "../../web/src/features/audit/types";
import type * as ApiClientModule from "../../web/src/api/client";

vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchAuditLog: vi.fn() };
});

import { fetchAuditLog } from "../../web/src/api/client";

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };
const timeRange: TimeRange = {
	minutes: 7 * 24 * 60,
	preset: "7d" as TimeRange["preset"],
	setPreset: () => {},
	clamp: (max) => ({ minutes: Math.min(7 * 24 * 60, max), clamped: false }),
	bounds: () => ({ from: "2026-09-21T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" }),
};

const event = (over: Partial<AuditEvent>): AuditEvent => ({
	id: "e",
	time: "2026-09-27T10:00:00Z",
	actionType: "update",
	description: "Update DNS Record",
	result: "success",
	actor: { type: "user", context: "dash", label: "admin@example.com" },
	resource: { product: "dns_records", type: "", id: "rec1", scope: "zones" },
	zone: { id: "z1", name: "example.com" },
	method: "PATCH",
	statusCode: 200,
	uri: "/zones/z1/dns_records/rec1",
	readOnly: false,
	...over,
});

const result: AuditLogResult = {
	truncated: false,
	window: { since: "", until: "" },
	events: [
		event({ id: "a" }),
		event({ id: "b", actionType: "delete", description: "Delete Tunnel", resource: { product: "cfd_tunnel", type: "", id: "t1", scope: "accounts" }, zone: undefined, result: "failure", statusCode: 403 }),
		event({ id: "c", actionType: "create", description: "Query analytics summary", resource: { product: "analytics", type: "query.summary", id: "", scope: "accounts" }, zone: undefined, readOnly: true }),
	],
};

async function renderPage() {
	vi.mocked(fetchAuditLog).mockResolvedValue(result);
	render(<AuditLogPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
	await screen.findByText("Update DNS Record");
}

describe("AuditLogPage", () => {
	// Filters are deep-linked through the hash, so one test's filter would otherwise greet the next.
	beforeEach(() => history.replaceState(null, "", "#/audit"));

	it("lists changes and hides dashboard analytics queries until asked", async () => {
		await renderPage();
		expect(screen.getByText("Delete Tunnel")).toBeInTheDocument();
		expect(screen.queryByText("Query analytics summary")).toBeNull();
		expect(screen.getByText("1 read-only queries hidden")).toBeInTheDocument();

		await userEvent.setup().click(screen.getByLabelText("Include dashboard analytics queries"));
		expect(screen.getByText("Query analytics summary")).toBeInTheDocument();
	});

	it("counts failures and deletions, and filters by action", async () => {
		await renderPage();
		// The refused deletion is marked in its row, with the status behind it.
		expect(screen.getByText("failed")).toHaveAttribute("title", "HTTP 403");
		await userEvent.setup().selectOptions(screen.getByLabelText("Filter by action"), "delete");
		expect(screen.getByText("Delete Tunnel")).toBeInTheDocument();
		expect(screen.queryByText("Update DNS Record")).toBeNull();
	});

	it("asks for the window it was given", async () => {
		await renderPage();
		expect(fetchAuditLog).toHaveBeenCalledWith("tok", { accountId: "acc1", from: "2026-09-21T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" });
	});
});

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "../../web/src/components/shell/Sidebar";
import type { Route } from "../../web/src/hooks/useRoute";

/**
 * The sidebar's link out to the self-hosted API docs. It is a plain <a>, not a Route — /docs is
 * served by the Worker outside the SPA's own hash routing — so this pins the three things that
 * matter for a link opened in a new tab: where it points, that it carries the safe `rel`, and
 * that it survives the collapsed sidebar state.
 */

function renderSidebar(collapsed = false) {
	render(
		<Sidebar
			accountId="acc1"
			accounts={[]}
			onSwitchAccount={vi.fn()}
			route={"access" as Route}
			onNavigate={vi.fn()}
			collapsed={collapsed}
			onToggleCollapsed={vi.fn()}
			mobileOpen={false}
			onMobileClose={vi.fn()}
			savedViewsVersion={0}
		/>,
	);
}

describe("Sidebar API docs link", () => {
	it("points at /docs and opens safely in a new tab", () => {
		renderSidebar();
		const link = screen.getByRole("link", { name: "API docs" });
		expect(link).toHaveAttribute("href", "/docs");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
		expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
	});

	it("still renders the link when the sidebar is collapsed", () => {
		renderSidebar(true);
		// Collapsed, the visible label is gone but the link itself — and its title tooltip — remain.
		const link = screen.getByTitle("API docs");
		expect(link).toHaveAttribute("href", "/docs");
	});
});

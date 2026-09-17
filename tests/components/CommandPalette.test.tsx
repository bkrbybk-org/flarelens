import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { CommandPalette, type CommandPaletteProps } from "../../web/src/components/shell/CommandPalette";
import type { Route } from "../../web/src/hooks/useRoute";

/**
 * The command palette is a dialog overlay reachable from anywhere: ⌘K/Ctrl+K, a proper combobox
 * (arrow keys, Enter, Home/End, aria-activedescendant), focus trapped while open and restored to
 * whatever had it beforehand on close, and — because it is the only reachable place to paste one
 * in a hurry — a Ray ID typed into the search box offers to trace it.
 */

function Harness({ open: initialOpen, onOpenChange, ...overrides }: Partial<CommandPaletteProps> = {}) {
	const [open, setOpen] = useState(initialOpen ?? false);
	return (
		<>
			<button type="button">Outside trigger</button>
			<CommandPalette
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					onOpenChange?.(next);
				}}
				route={"access" as Route}
				onNavigate={vi.fn()}
				accounts={[]}
				accountId="acc1"
				onSwitchAccount={vi.fn()}
				theme="dark"
				onSetTheme={vi.fn()}
				collapsed={false}
				onToggleCollapsed={vi.fn()}
				onRefresh={undefined}
				refreshing={false}
				showRefresh={false}
				onDisconnect={vi.fn()}
				onSaveView={vi.fn()}
				{...overrides}
			/>
		</>
	);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CommandPalette", () => {
	it("is closed by default and opens on Cmd+K", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await user.keyboard("{Meta>}k{/Meta}");
		expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
	});

	it("renders a combobox wired to its listbox", async () => {
		render(<Harness open />);
		const combobox = screen.getByRole("combobox");
		expect(combobox).toHaveAttribute("aria-expanded", "true");
		expect(combobox).toHaveAttribute("aria-controls", "command-palette-listbox");
		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	it("filters commands by fuzzy/substring match", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.type(screen.getByRole("combobox"), "waf");
		expect(screen.getByRole("option", { name: /WAF Analytics/ })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /Tunnel Map/ })).not.toBeInTheDocument();
	});

	it("highlights the matched characters", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.type(screen.getByRole("combobox"), "waf");
		const option = screen.getByRole("option", { name: /WAF Analytics/ });
		expect(option.querySelector("mark")).not.toBeNull();
		expect(option.querySelector("mark")?.textContent?.toLowerCase()).toBe("waf");
	});

	it("moves the active option with the arrow keys and tracks it via aria-activedescendant", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		const combobox = screen.getByRole("combobox");
		await user.type(combobox, "a");
		const options = screen.getAllByRole("option");
		expect(options.length).toBeGreaterThan(1);

		await user.keyboard("{ArrowDown}");
		const active = combobox.getAttribute("aria-activedescendant");
		expect(active).toBe(options[1].id);
		expect(options[1]).toHaveAttribute("aria-selected", "true");
	});

	it("Home/End jump to the first/last option", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		const combobox = screen.getByRole("combobox");
		await user.type(combobox, "a");
		const options = screen.getAllByRole("option");

		await user.keyboard("{End}");
		expect(combobox.getAttribute("aria-activedescendant")).toBe(options[options.length - 1].id);

		await user.keyboard("{Home}");
		expect(combobox.getAttribute("aria-activedescendant")).toBe(options[0].id);
	});

	it("navigates on Enter and closes", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		render(<Harness open onNavigate={onNavigate} />);
		await user.type(screen.getByRole("combobox"), "waf analytics");
		await user.keyboard("{Enter}");
		expect(onNavigate).toHaveBeenCalledWith("waf");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("closes on Escape and restores focus to whatever had it before opening", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const trigger = screen.getByText("Outside trigger");
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		await user.keyboard("{Meta>}k{/Meta}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on backdrop click", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.click(screen.getByRole("button", { name: "Close command palette" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("offers to trace a Ray ID typed into the search box", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.type(screen.getByRole("combobox"), "a3633412999ba62b");
		expect(screen.getByRole("option", { name: /Trace Ray ID/ })).toBeInTheDocument();
	});

	it("also accepts a Ray ID with a colo suffix", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.type(screen.getByRole("combobox"), "a3633412999ba62b-BKK");
		expect(screen.getByRole("option", { name: /Trace Ray ID/ })).toBeInTheDocument();
	});

	it("does not offer a Ray ID trace for ordinary search text", async () => {
		const user = userEvent.setup();
		render(<Harness open />);
		await user.type(screen.getByRole("combobox"), "cache rules");
		expect(screen.queryByRole("option", { name: /Trace Ray ID/ })).not.toBeInTheDocument();
	});

	it("only offers account switching when there is more than one account", async () => {
		render(<Harness open accounts={[{ id: "acc1", name: "Acme" }]} />);
		expect(screen.queryByRole("option", { name: /Switch to/ })).not.toBeInTheDocument();
	});

	it("lists other accounts as switch commands when there are several", async () => {
		render(
			<Harness
				open
				accounts={[
					{ id: "acc1", name: "Acme" },
					{ id: "acc2", name: "Globex" },
				]}
			/>,
		);
		expect(screen.getByRole("option", { name: "Switch to Globex" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /Switch to Acme/ })).not.toBeInTheDocument();
	});
});

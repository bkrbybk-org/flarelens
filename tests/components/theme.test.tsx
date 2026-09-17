import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { usePrefs, type Theme } from "../../web/src/hooks/usePrefs";
import { Topbar } from "../../web/src/components/shell/Topbar";

/**
 * Theme has three states — dark, light, system — where "system" tracks the OS live via
 * matchMedia rather than being a snapshot taken once. jsdom has no real matchMedia, so these
 * tests drive a fake one and fire its change listener by hand.
 */

type Listener = (e: { matches: boolean }) => void;

function installMatchMedia(initialDark: boolean) {
	let dark = initialDark;
	let listener: Listener | null = null;
	const mql = {
		get matches() {
			return dark;
		},
		media: "(prefers-color-scheme: dark)",
		addEventListener: (_: string, cb: Listener) => {
			listener = cb;
		},
		removeEventListener: () => {
			listener = null;
		},
	};
	window.matchMedia = ((query: string) => {
		void query;
		return mql as unknown as MediaQueryList;
	}) as typeof window.matchMedia;
	return {
		setDark(next: boolean) {
			dark = next;
			listener?.({ matches: next });
		},
	};
}

function Harness() {
	const { prefs, updatePrefs, effectiveDark } = usePrefs();
	return (
		<div>
			<div data-testid="theme">{prefs.theme}</div>
			{/* Driven by the hook's own `effectiveDark`, not a live DOM read: the class on
			    <html> is applied in an effect after this renders, so reading the DOM directly
			    here would show last render's value, one render behind reality. */}
			<div data-testid="dark-class">{effectiveDark ? "dark" : "light"}</div>
			<button type="button" onClick={() => updatePrefs({ theme: "light" })}>set light</button>
			<button type="button" onClick={() => updatePrefs({ theme: "system" })}>set system</button>
			<button type="button" onClick={() => updatePrefs({ theme: "dark" })}>set dark</button>
		</div>
	);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	document.documentElement.classList.remove("dark");
});

describe("theme: system", () => {
	it("follows the OS preference", async () => {
		const media = installMatchMedia(true);
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByText("set system"));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("dark");

		act(() => media.setDark(false));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("light");

		act(() => media.setDark(true));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("dark");
	});

	it("stops following once switched away from system", async () => {
		const media = installMatchMedia(true);
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByText("set system"));
		await user.click(screen.getByText("set light"));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("light");

		// The OS changing after that must not un-pin the explicit choice.
		act(() => media.setDark(true));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("light");
	});

	it("re-reads the OS preference immediately on switching back to system", async () => {
		installMatchMedia(false);
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByText("set dark"));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("dark");

		// Switching to "system" must reflect the current OS state right away, not the value
		// read on this hook's first render.
		await user.click(screen.getByText("set system"));
		expect(screen.getByTestId("dark-class")).toHaveTextContent("light");
	});

	it("defaults existing users to dark, not system", () => {
		installMatchMedia(false);
		render(<Harness />);
		expect(screen.getByTestId("theme")).toHaveTextContent("dark");
	});
});

function TopbarHarness() {
	const [theme, setTheme] = useState<Theme>("dark");
	return (
		<Topbar
			title="Test"
			theme={theme}
			onCycleTheme={() => setTheme((t) => (t === "dark" ? "light" : t === "light" ? "system" : "dark"))}
			syncing={false}
			showSync={false}
			onDisconnect={vi.fn()}
			mode="byot"
			onMobileMenu={vi.fn()}
			onOpenPalette={vi.fn()}
			onSaveView={vi.fn()}
		/>
	);
}

describe("theme: Topbar cycle order", () => {
	it("cycles dark → light → system → dark", async () => {
		const user = userEvent.setup();
		render(<TopbarHarness />);
		const button = screen.getByRole("button", { name: /^Theme: dark/ });
		expect(button).toBeInTheDocument();

		await user.click(button);
		expect(screen.getByRole("button", { name: /^Theme: light/ })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^Theme: light/ }));
		expect(screen.getByRole("button", { name: /^Theme: system/ })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^Theme: system/ }));
		expect(screen.getByRole("button", { name: /^Theme: dark/ })).toBeInTheDocument();
	});
});

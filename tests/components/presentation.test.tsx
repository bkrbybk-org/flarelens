import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAutoRefresh, usePresentation, usePresentationTextScale } from "../../web/src/hooks/usePresentation";
import { PresentationBar } from "../../web/src/components/shell/PresentationBar";
import { aliasLetters, useHideNamesPreference, useMaskEmails } from "../../web/src/hooks/useHideNames";
import { Topbar } from "../../web/src/components/shell/Topbar";

/** Presentation mode: full screen when the browser allows, the mode either way, and auto-refresh. */

let fullscreenElement: Element | null = null;

function fakeFullscreen(enabled = true) {
	Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
	Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
	document.documentElement.requestFullscreen = vi.fn(async () => {
		fullscreenElement = document.documentElement;
		document.dispatchEvent(new Event("fullscreenchange"));
	});
	document.exitFullscreen = vi.fn(async () => {
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));
	});
}

beforeEach(() => {
	fullscreenElement = null;
	fakeFullscreen();
});
afterEach(() => vi.useRealTimers());

describe("usePresentation", () => {
	it("asks for full screen, and leaves the mode when the browser leaves full screen (Esc, F11)", async () => {
		const { result } = renderHook(() => usePresentation());
		await act(() => result.current.enter());
		expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
		expect(result.current.active).toBe(true);
		// The browser's own exit, as Esc does it.
		act(() => {
			fullscreenElement = null;
			document.dispatchEvent(new Event("fullscreenchange"));
		});
		expect(result.current.active).toBe(false);
	});

	it("still presents when full screen is refused, and Esc leaves", async () => {
		fakeFullscreen(true);
		document.documentElement.requestFullscreen = vi.fn(async () => {
			throw new Error("Permissions check failed");
		});
		const { result } = renderHook(() => usePresentation());
		await act(() => result.current.enter());
		expect(result.current.active).toBe(true);
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(result.current.active).toBe(false);
	});

	it("exits full screen on exit", async () => {
		const { result } = renderHook(() => usePresentation());
		await act(() => result.current.enter());
		act(() => result.current.exit());
		expect(document.exitFullscreen).toHaveBeenCalled();
		expect(result.current.active).toBe(false);
	});
});

describe("usePresentationTextScale", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.style.fontSize = "";
	});

	it("enlarges the text only while presenting, Large by default, and puts it back on leaving", () => {
		const { result, rerender } = renderHook(({ active }) => usePresentationTextScale(active), { initialProps: { active: false } });
		expect(result.current[0]).toBe(125);
		expect(document.documentElement.style.fontSize).toBe("");
		rerender({ active: true });
		expect(document.documentElement.style.fontSize).toBe("125%");
		rerender({ active: false });
		expect(document.documentElement.style.fontSize).toBe("");
	});

	it("remembers the size picked, and Normal leaves the page as it is", () => {
		const { result, unmount } = renderHook(() => usePresentationTextScale(true));
		act(() => result.current[1](150));
		expect(document.documentElement.style.fontSize).toBe("150%");
		act(() => result.current[1](100));
		expect(document.documentElement.style.fontSize).toBe("");
		unmount();
		act(() => {
			localStorage.setItem("flarelens_present_text", "150");
		});
		expect(renderHook(() => usePresentationTextScale(false)).result.current[0]).toBe(150);
		// A value that is not one of the choices falls back to Large.
		localStorage.setItem("flarelens_present_text", "999");
		expect(renderHook(() => usePresentationTextScale(false)).result.current[0]).toBe(125);
	});
});

describe("useAutoRefresh", () => {
	it("refreshes on the interval, skips a tick while a reload runs, and stops when off", () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const { rerender } = renderHook(({ ms, busy }) => useAutoRefresh(ms, refresh, busy), { initialProps: { ms: 60_000, busy: false } });
		vi.advanceTimersByTime(60_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		rerender({ ms: 60_000, busy: true });
		vi.advanceTimersByTime(60_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		rerender({ ms: 0, busy: false });
		vi.advanceTimersByTime(300_000);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe("controls", () => {
	it("the bar says what is on screen and how current it is, and offers refresh and exit", async () => {
		const onAutoRefresh = vi.fn();
		const onExit = vi.fn();
		const onRefresh = vi.fn();
		const user = userEvent.setup();
		render(
			<PresentationBar
				title="AI Gateway"
				accountName="Acme"
				windowLabel="Last 7 days"
				updatedAt={new Date("2026-11-04T10:15:00")}
				refreshing={false}
				autoRefreshMs={0}
				onAutoRefresh={onAutoRefresh}
				onRefresh={onRefresh}
				onExit={onExit}
			/>,
		);
		expect(screen.getByRole("heading", { name: "AI Gateway" })).toBeInTheDocument();
		expect(screen.getByText("Acme · Last 7 days")).toBeInTheDocument();
		expect(screen.getByText(/^Updated /)).toBeInTheDocument();
		await user.selectOptions(screen.getByRole("combobox", { name: "Auto-refresh" }), "300000");
		expect(onAutoRefresh).toHaveBeenCalledWith(300_000);
		await user.click(screen.getByRole("button", { name: "Refresh now" }));
		expect(onRefresh).toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /Exit full screen/ }));
		expect(onExit).toHaveBeenCalled();
		// No text size picker unless the shell wires one.
		expect(screen.queryByRole("combobox", { name: "Text size" })).toBeNull();
	});

	it("the bar offers a text size for a screen read from across the room", async () => {
		const onTextScale = vi.fn();
		const user = userEvent.setup();
		render(
			<PresentationBar
				title="AI Gateway"
				accountName="Acme"
				updatedAt={null}
				refreshing={false}
				autoRefreshMs={0}
				onAutoRefresh={vi.fn()}
				onExit={vi.fn()}
				textScale={125}
				onTextScale={onTextScale}
			/>,
		);
		const picker = screen.getByRole("combobox", { name: "Text size" });
		expect(picker).toHaveValue("125");
		expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Normal", "Large", "Extra large"]);
		await user.selectOptions(picker, "150");
		expect(onTextScale).toHaveBeenCalledWith(150);
	});

	it("hides people's names by default while presenting, and remembers turning that off", async () => {
		localStorage.removeItem("flarelens_present_hide_names");
		const { result } = renderHook(() => useHideNamesPreference());
		expect(result.current[0]).toBe(true);
		act(() => result.current[1](false));
		expect(renderHook(() => useHideNamesPreference()).result.current[0]).toBe(false);
		const onHideNames = vi.fn();
		const user = userEvent.setup();
		render(
			<PresentationBar
				title="AI Gateway"
				accountName="Acme"
				updatedAt={null}
				refreshing={false}
				autoRefreshMs={0}
				onAutoRefresh={vi.fn()}
				onExit={vi.fn()}
				hideNames={true}
				onHideNames={onHideNames}
			/>,
		);
		const box = screen.getByRole("checkbox", { name: "Hide names" });
		expect(box).toBeChecked();
		await user.click(box);
		expect(onHideNames).toHaveBeenCalledWith(false);
		localStorage.removeItem("flarelens_present_hide_names");
		expect(aliasLetters(0) + aliasLetters(25) + aliasLetters(26) + aliasLetters(27)).toBe("AZAAAB");
	});

	describe("masking emails on screen", () => {
		function Page({ active, text = "identity.email == \"a.person@example.com\"", title = "actor b@example.org" }: { active: boolean; text?: string; title?: string }) {
			useMaskEmails(active);
			return (
				<div>
					<code>{text}</code>
					<span title={title} aria-label="x">hover</span>
					<p>a.person@example.com again</p>
					<input aria-label="search" defaultValue="typed@example.com" placeholder="someone@example.com" />
				</div>
			);
		}
		const flush = () => act(async () => {});

		it("shows every address as a stable alias, in text and tooltips, and leaves what was typed", () => {
			const { container } = render(<Page active={true} />);
			// One person, one alias, wherever they appear; another person, another.
			const alias = /"(Person [A-Z])"/.exec(container.querySelector("code")!.textContent!)![1];
			expect(container.querySelector("p")).toHaveTextContent(`${alias} again`);
			expect(container.querySelector("span")!.getAttribute("title")).toMatch(/^actor Person [A-Z]$/);
			expect(container.querySelector("span")!.getAttribute("title")).not.toContain(alias);
			expect(container.querySelector("input")).toHaveValue("typed@example.com");
			expect(container.querySelector("input")).toHaveAttribute("placeholder", "someone@example.com");
		});

		it("catches text React writes later, and what mounts later", async () => {
			const { container, rerender } = render(<Page active={true} />);
			rerender(<Page active={true} text="new.one@example.net" title="c@example.org" />);
			await flush();
			expect(container.querySelector("code")).toHaveTextContent(/^Person [A-Z]$/);
			expect(container.querySelector("code")?.textContent).not.toContain("@");
			expect(container.querySelector("span")?.getAttribute("title")).not.toContain("@");
			const late = document.createElement("div");
			late.textContent = "late@example.com";
			container.appendChild(late);
			await flush();
			expect(late.textContent).toMatch(/^Person [A-Z]$/);
		});

		it("puts the originals back on leaving, and leaves the page alone while off", async () => {
			const { container, rerender } = render(<Page active={false} />);
			expect(container.querySelector("p")).toHaveTextContent("a.person@example.com again");
			rerender(<Page active={true} />);
			expect(container.querySelector("p")).toHaveTextContent(/^Person [A-Z] again$/);
			rerender(<Page active={false} />);
			await flush();
			expect(container.querySelector("p")).toHaveTextContent("a.person@example.com again");
			expect(container.querySelector("code")).toHaveTextContent('identity.email == "a.person@example.com"');
			expect(container.querySelector("span")).toHaveAttribute("title", "actor b@example.org");
		});
	});

	it("the top bar offers full screen", async () => {
		const onPresent = vi.fn();
		const user = userEvent.setup();
		render(
			<Topbar
				title="WAF"
				theme="dark"
				onCycleTheme={vi.fn()}
				syncing={false}
				onDisconnect={vi.fn()}
				mode="server"
				onMobileMenu={vi.fn()}
				onOpenPalette={vi.fn()}
				onSaveView={vi.fn()}
				onPresent={onPresent}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Full screen" }));
		expect(onPresent).toHaveBeenCalled();
	});
});

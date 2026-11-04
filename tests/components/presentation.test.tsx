import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAutoRefresh, usePresentation } from "../../web/src/hooks/usePresentation";
import { PresentationBar } from "../../web/src/components/shell/PresentationBar";
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { loadRotation, nextRoute, saveRotation, usePageRotation, type RotationConfig } from "../../web/src/hooks/usePageRotation";
import { PresentationBar, type RotationControls } from "../../web/src/components/shell/PresentationBar";
import type { Route } from "../../web/src/hooks/useRoute";
import { NAV_GROUPS } from "../../web/src/components/shell/nav";

/** Page rotation for an unattended presentation screen. */

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("nextRoute", () => {
	it("loops, starts from the top when the page is not in the loop, and needs two pages", () => {
		const loop: Route[] = ["ai-gateway", "waf", "findings"];
		expect(nextRoute(loop, "ai-gateway")).toBe("waf");
		expect(nextRoute(loop, "findings")).toBe("ai-gateway");
		expect(nextRoute(loop, "dns")).toBe("ai-gateway");
		expect(nextRoute(["waf"], "dns")).toBeNull();
	});
});

describe("saved rotation", () => {
	it("round-trips, and drops unknown pages and intervals", () => {
		saveRotation({ routes: ["waf", "findings"], intervalMs: 120_000 });
		expect(loadRotation()).toEqual({ routes: ["waf", "findings"], intervalMs: 120_000 });
		localStorage.setItem("flarelens_rotation", JSON.stringify({ routes: ["waf", "nope", "waf"], intervalMs: 7 }));
		expect(loadRotation()).toEqual({ routes: ["waf"], intervalMs: 60_000 });
		localStorage.setItem("flarelens_rotation", "{not json");
		expect(loadRotation()).toEqual({ routes: [], intervalMs: 60_000 });
	});
});

describe("usePageRotation", () => {
	const config: RotationConfig = { routes: ["ai-gateway", "waf"], intervalMs: 30_000 };

	it("moves to the next page when the interval runs out, and restarts the count on arrival", () => {
		vi.useFakeTimers();
		const navigate = vi.fn();
		const { result, rerender } = renderHook(({ route }) => usePageRotation({ running: true, paused: false, config, route, navigate }), {
			initialProps: { route: "ai-gateway" as Route },
		});
		expect(result.current).toEqual({ next: "waf", secondsLeft: 30 });
		act(() => vi.advanceTimersByTime(29_000));
		expect(navigate).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(1_000));
		expect(navigate).toHaveBeenCalledWith("waf");
		rerender({ route: "waf" });
		expect(result.current).toEqual({ next: "ai-gateway", secondsLeft: 30 });
	});

	it("holds while paused, and does nothing when not running", () => {
		vi.useFakeTimers();
		const navigate = vi.fn();
		const { result, rerender } = renderHook(({ paused, running }) => usePageRotation({ running, paused, config, route: "ai-gateway", navigate }), {
			initialProps: { paused: true, running: true },
		});
		act(() => vi.advanceTimersByTime(60_000));
		expect(navigate).not.toHaveBeenCalled();
		expect(result.current.secondsLeft).toBe(30);
		rerender({ paused: false, running: false });
		act(() => vi.advanceTimersByTime(60_000));
		expect(navigate).not.toHaveBeenCalled();
		expect(result.current.next).toBeNull();
	});
});

describe("rotation controls", () => {
	const base = { title: "AI Gateway", accountName: "Acme", updatedAt: null, refreshing: false, autoRefreshMs: 0, onAutoRefresh: vi.fn(), onExit: vi.fn() };
	const controls = (over: Partial<RotationControls> = {}): RotationControls => ({
		config: { routes: [], intervalMs: 60_000 },
		running: false,
		paused: false,
		next: null,
		secondsLeft: 0,
		position: 0,
		onStart: vi.fn(),
		onPause: vi.fn(),
		onResume: vi.fn(),
		onStop: vi.fn(),
		...over,
	});

	it("picks pages and an interval, in menu order, and needs two pages to start", async () => {
		const rotation = controls();
		const user = userEvent.setup();
		render(<PresentationBar {...base} rotation={rotation} />);
		await user.click(screen.getByRole("button", { name: "Rotate pages…" }));
		const dialog = screen.getByRole("dialog", { name: "Page rotation" });
		const start = screen.getByRole("button", { name: "Start rotation" });
		await user.click(screen.getByRole("checkbox", { name: "Findings" }));
		expect(start).toBeDisabled();
		await user.click(screen.getByRole("checkbox", { name: "AI Gateway" }));
		await user.selectOptions(screen.getByRole("combobox", { name: "Each page for" }), "120000");
		expect(dialog).toHaveTextContent("2 selected");
		await user.click(start);
		const started = vi.mocked(rotation.onStart).mock.calls[0][0];
		expect(started.intervalMs).toBe(120_000);
		// Sidebar order, whatever order they were ticked in.
		const menuOrder = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.route)).filter((r) => r === "findings" || r === "ai-gateway");
		expect(started.routes).toEqual(menuOrder);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says where the loop is and what comes next, with pause and stop", async () => {
		const rotation = controls({ running: true, config: { routes: ["ai-gateway", "waf", "findings"], intervalMs: 60_000 }, next: "waf", secondsLeft: 75, position: 1 });
		const user = userEvent.setup();
		render(<PresentationBar {...base} rotation={rotation} />);
		expect(screen.getByRole("status")).toHaveTextContent("Rotating 1/3 · next: WAF Analytics in 1:15");
		await user.click(screen.getByRole("button", { name: "Pause" }));
		expect(rotation.onPause).toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Stop rotation" }));
		expect(rotation.onStop).toHaveBeenCalled();
	});
});

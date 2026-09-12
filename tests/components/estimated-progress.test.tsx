import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEstimatedProgress } from "../../web/src/hooks/useEstimatedProgress";

/**
 * The estimate is measured, not assumed. These pin where it comes from and when it stops being
 * offered — the hook is the only thing that knows whether a section has ever been timed.
 */

const KEY = "test_last_load_ms";

beforeEach(() => {
	sessionStorage.clear();
	vi.useRealTimers();
});

describe("useEstimatedProgress", () => {
	it("offers no estimate until a load has actually been timed", () => {
		const { result } = renderHook(() => useEstimatedProgress(KEY));
		act(() => result.current.start());
		expect(result.current.measured).toBe(false);
		expect(result.current.etaMs).toBeNull();
	});

	it("uses the recorded duration on the next load", () => {
		sessionStorage.setItem(KEY, "4000");
		const { result } = renderHook(() => useEstimatedProgress(KEY));
		act(() => result.current.start());
		expect(result.current.measured).toBe(true);
		expect(result.current.etaMs).toBe(4000);
	});

	it("blends each success with the previous estimate rather than replacing it", () => {
		// One unusually slow load should not make every later countdown wrong.
		sessionStorage.setItem(KEY, "4000");
		const { result } = renderHook(() => useEstimatedProgress(KEY));
		act(() => result.current.start());
		act(() => result.current.stop(true));
		const stored = Number(sessionStorage.getItem(KEY));
		expect(stored).toBeGreaterThan(0);
		expect(stored).toBeLessThan(4000);
	});

	it("records nothing from a failed load", () => {
		// A load that errored says nothing about how long a successful one takes.
		const { result } = renderHook(() => useEstimatedProgress(KEY));
		act(() => result.current.start());
		act(() => result.current.stop(false));
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});
});

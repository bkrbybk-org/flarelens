import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHashParams, setHashParam, useHashSyncedState } from "../web/src/hooks/useHashParams";

// --- Minimal fake React hook runtime ------------------------------------
// No jsdom and no @testing-library/react here, so there is no real renderer to mount
// useHashSyncedState against. Its use of React is narrow enough to fake directly:
// useRef just needs a slot that survives across calls, and useEffect just needs to
// skip re-running when its deps are unchanged — call order across a "render" stands
// in for React's hook list. Good enough to drive the hook through a mount and a
// simulated cross-route re-render and observe adoption/write-back ordering.
interface HookSlot {
	ref?: { current: unknown };
	deps?: unknown[];
}
const hookState = vi.hoisted(() => ({ slots: [] as HookSlot[], cursor: 0 }));

vi.mock("react", () => ({
	useRef: (init: unknown) => {
		const i = hookState.cursor++;
		if (!hookState.slots[i]) hookState.slots[i] = { ref: { current: init } };
		return hookState.slots[i].ref;
	},
	useEffect: (fn: () => void, deps?: unknown[]) => {
		const i = hookState.cursor++;
		const slot = hookState.slots[i] ?? (hookState.slots[i] = {});
		const prev = slot.deps;
		const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, idx) => d !== prev[idx]);
		slot.deps = deps;
		if (changed) fn();
	},
}));

// Simulates one render: resets the hook-list cursor (as React does per render) and
// calls the hook body, which re-runs any effect whose deps moved since last time.
function renderHashSyncedState(key: string, value: string, setValue: (next: string) => void, route: string) {
	hookState.cursor = 0;
	useHashSyncedState(key, value, setValue, route);
}

// No jsdom in this project: useHashParams touches window.location.hash and the
// global history object directly, so both are stubbed by hand. Typed rather than cast to
// `any`, so a change in what the module touches surfaces here as a type error.
interface StubbedGlobals {
	window?: { location: { hash: string } };
	history?: { replaceState: (state: unknown, unused: string, url: string) => void };
}
const stubbed = globalThis as unknown as StubbedGlobals;

let replaceState: ReturnType<typeof vi.fn<(state: unknown, unused: string, url: string) => void>>;

beforeEach(() => {
	replaceState = vi.fn();
	stubbed.window = { location: { hash: "" } };
	stubbed.history = { replaceState };
});

afterEach(() => {
	delete stubbed.window;
	delete stubbed.history;
});

function setHash(hash: string) {
	stubbed.window!.location.hash = hash;
}

describe("getHashParams", () => {
	it("parses params out of the query part of a route hash", () => {
		setHash("#/waf?zone=abc&sort=name");
		const params = getHashParams();
		expect(params.get("zone")).toBe("abc");
		expect(params.get("sort")).toBe("name");
	});

	it("returns an empty set for a route hash with no query part", () => {
		setHash("#/waf");
		expect(Array.from(getHashParams().keys())).toHaveLength(0);
	});

	it("returns an empty set when there is no hash at all", () => {
		setHash("");
		expect(Array.from(getHashParams().keys())).toHaveLength(0);
	});
});

describe("setHashParam", () => {
	it("adds a new param onto an existing query, keeping the route prefix", () => {
		setHash("#/waf?zone=abc");
		setHashParam("mode", "list");
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=abc&mode=list");
	});

	it("overwrites an existing param in place rather than duplicating it", () => {
		setHash("#/waf?zone=abc&mode=grid");
		setHashParam("zone", "def");
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=def&mode=grid");
	});

	it("removes a param when passed null", () => {
		setHash("#/waf?zone=abc&mode=grid");
		setHashParam("mode", null);
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=abc");
	});

	it("removes a param when passed an empty string, same as null", () => {
		setHash("#/waf?zone=abc&mode=grid");
		setHashParam("mode", "");
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=abc");
	});

	it("the route path portion survives a param write onto a hash with no existing query", () => {
		setHash("#/waf");
		setHashParam("zone", "abc");
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=abc");
	});

	it("does not touch history when the write would be a no-op", () => {
		setHash("#/waf?zone=abc");
		setHashParam("zone", "abc");
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("does not touch history when deleting a param that was never set", () => {
		setHash("#/waf");
		setHashParam("zone", null);
		expect(replaceState).not.toHaveBeenCalled();
	});

	// Regression: this used to write a bare "?zone=abc", which replaceState reads as the page's
	// QUERY STRING rather than its fragment — rewriting the real URL and dropping the path.
	// Reachable on a fresh load of "/" now that sections sync their range into the hash.
	it("anchors to the default route when the hash is empty, instead of writing a bare query", () => {
		setHash("");
		setHashParam("zone", "abc");
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/?zone=abc");
	});
});

describe("useHashSyncedState", () => {
	// Regression for the App shell never unmounting: hand-editing the hash to a DIFFERENT
	// route while the app is open used to be silently dropped, because adoption only ever
	// ran once, on mount. Sequence: mount already synced at #/waf?zone=A, then the hash is
	// hand-edited to #/cache?zone=B and the route prop changes accordingly (as useRoute's
	// hashchange listener would drive it) — the new zone must be adopted.
	it("adopts the hash param on arrival at a different route, not just on mount", () => {
		setHash("#/waf?zone=A");
		const setValue = vi.fn();

		// Steady state: already mounted at "waf" with value in sync with the hash.
		renderHashSyncedState("zone", "A", setValue, "waf");
		expect(setValue).not.toHaveBeenCalled();

		// Hand-edit to a different route with a different param value. The App component
		// stays mounted; only `route` changes (state is still the stale "A" this render).
		setHash("#/cache?zone=B");
		renderHashSyncedState("zone", "A", setValue, "cache");

		expect(setValue).toHaveBeenCalledWith("B");
		// The stale pre-adoption value ("A") must never get written back onto the new
		// route's hash — that would clobber the hand-typed "B" right back out.
		expect(replaceState).not.toHaveBeenCalled();
	});

	it("does not clobber state when re-rendering at the same route (no false adoption loop)", () => {
		setHash("#/waf?zone=A");
		const setValue = vi.fn();
		renderHashSyncedState("zone", "A", setValue, "waf");
		renderHashSyncedState("zone", "A", setValue, "waf");
		expect(setValue).not.toHaveBeenCalled();
	});

	it("mirrors a state-driven value change back into the hash without re-adopting", () => {
		setHash("#/waf?zone=A");
		const setValue = vi.fn();
		renderHashSyncedState("zone", "A", setValue, "waf");
		renderHashSyncedState("zone", "B", setValue, "waf"); // user picked a new zone in-app
		expect(setValue).not.toHaveBeenCalled();
		expect(replaceState).toHaveBeenCalledWith(null, "", "#/waf?zone=B");
	});
});

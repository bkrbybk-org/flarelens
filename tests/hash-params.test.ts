import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHashParams, setHashParam } from "../web/src/hooks/useHashParams";

// No jsdom in this project: useHashParams touches window.location.hash and the
// global history object directly, so both are stubbed by hand. Typed rather than cast to
// `any`, so a change in what the module touches surfaces here as a type error.
interface StubbedGlobals {
	window?: { location: { hash: string } };
	history?: { replaceState: (state: unknown, unused: string, url: string) => void };
}
const stubbed = globalThis as unknown as StubbedGlobals;

let replaceState: ReturnType<typeof vi.fn>;

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

// useHashSyncedState is a React hook (useEffect/useRef) and is not covered here:
// this project has no jsdom and no @testing-library/react-hooks equivalent to
// mount it against, so there is no way to exercise its effect timing in this
// node test environment.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../../web/src/hooks/useSession";
import { usePrefs } from "../../web/src/hooks/usePrefs";
import { storageGet, storageRemove, storageSet } from "../../web/src/lib/storage";

/** What a browser that blocks site data does: touching the storage object itself throws. */
function blockStorage() {
	const deny = () => {
		throw new DOMException("The operation is insecure.", "SecurityError");
	};
	vi.spyOn(window, "localStorage", "get").mockImplementation(deny);
	vi.spyOn(window, "sessionStorage", "get").mockImplementation(deny);
}

afterEach(() => vi.restoreAllMocks());

describe("storage helper", () => {
	it("round-trips when storage works", () => {
		storageSet("session", "k", "v");
		expect(storageGet("session", "k")).toBe("v");
		storageRemove("session", "k");
		expect(storageGet("session", "k")).toBeNull();
	});

	it("never throws when the browser blocks storage", () => {
		blockStorage();
		expect(() => storageSet("local", "k", "v")).not.toThrow();
		expect(storageGet("local", "k")).toBeNull();
		expect(() => storageRemove("session", "k")).not.toThrow();
	});

	it("keeps the session and prefs hooks alive with storage blocked", () => {
		blockStorage();
		const session = renderHook(() => useSession());
		expect(session.result.current.session).toBeNull();
		expect(() => session.result.current.connect({ token: "t", accountId: "a", accountName: "A", mode: "byot" })).not.toThrow();
		expect(() => renderHook(() => usePrefs())).not.toThrow();
	});
});

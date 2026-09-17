import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteView,
	isNavigableHash,
	listViews,
	navigateToView,
	renameView,
	saveView,
} from "../../web/src/lib/savedViews";

/**
 * Saved views live in localStorage, which can be unavailable (private browsing, quota, disabled
 * entirely) or hold whatever a previous build or a hand-edit left behind. Every entry point here
 * has to survive both: it is a `.tsx` file under `tests/components` — the jsdom project — purely
 * because `localStorage` doesn't exist in the `node` project's environment, not because this
 * exercises any React.
 */

const STORAGE_KEY = "flarelens_saved_views";

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("saveView / listViews", () => {
	it("lists views for an account, newest first", () => {
		const a = saveView("acc1", "First", "#/waf?zone=z1");
		const b = saveView("acc1", "Second", "#/cache?zone=z2");
		expect(listViews("acc1").map((v) => v.id)).toEqual([b.id, a.id]);
		expect(a.accountId).toBe("acc1");
		expect(a.hash).toBe("#/waf?zone=z1");
	});

	it("never lists another account's views", () => {
		saveView("acc1", "Mine", "#/waf");
		saveView("acc2", "Theirs", "#/cache");
		expect(listViews("acc1").map((v) => v.name)).toEqual(["Mine"]);
		expect(listViews("acc2").map((v) => v.name)).toEqual(["Theirs"]);
	});

	it("caps at 50 per account by dropping the oldest", () => {
		for (let i = 0; i < 55; i++) {
			saveView("acc1", `view-${i}`, "#/waf");
		}
		const views = listViews("acc1");
		expect(views).toHaveLength(50);
		expect(views.some((v) => v.name === "view-0")).toBe(false);
		expect(views.some((v) => v.name === "view-54")).toBe(true);
	});

	it("does not cap a different account's views when one account is full", () => {
		for (let i = 0; i < 50; i++) saveView("acc1", `a-${i}`, "#/waf");
		saveView("acc2", "still here", "#/cache");
		expect(listViews("acc2")).toHaveLength(1);
	});
});

describe("renameView / deleteView", () => {
	it("renames only the targeted view, scoped to its account", () => {
		const view = saveView("acc1", "Old name", "#/waf");
		saveView("acc2", "Old name", "#/waf");
		renameView("acc1", view.id, "New name");
		expect(listViews("acc1")[0].name).toBe("New name");
		expect(listViews("acc2")[0].name).toBe("Old name");
	});

	it("ignores an empty rename", () => {
		const view = saveView("acc1", "Keep me", "#/waf");
		renameView("acc1", view.id, "   ");
		expect(listViews("acc1")[0].name).toBe("Keep me");
	});

	it("deletes only the targeted view", () => {
		const a = saveView("acc1", "A", "#/waf");
		const b = saveView("acc1", "B", "#/cache");
		deleteView("acc1", a.id);
		expect(listViews("acc1").map((v) => v.id)).toEqual([b.id]);
	});
});

describe("malformed entries", () => {
	it("drops entries that fail validation on read", () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				{ id: "1", name: "Valid", hash: "#/waf", accountId: "acc1", createdAt: 1 },
				{ id: "2", name: "No hash prefix", hash: "waf?zone=z", accountId: "acc1", createdAt: 2 },
				{ id: "3", name: "", hash: "#/waf", accountId: "acc1", createdAt: 3 },
				{ hash: "#/waf", accountId: "acc1", createdAt: 4 },
				"not even an object",
				null,
			]),
		);
		expect(listViews("acc1").map((v) => v.id)).toEqual(["1"]);
	});

	it("treats non-array JSON as empty rather than throwing", () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
		expect(listViews("acc1")).toEqual([]);
	});

	it("treats unparsable JSON as empty rather than throwing", () => {
		localStorage.setItem(STORAGE_KEY, "{not json");
		expect(listViews("acc1")).toEqual([]);
		expect(() => saveView("acc1", "Recovers", "#/waf")).not.toThrow();
	});
});

describe("storage throwing", () => {
	it("read survives a throwing localStorage.getItem", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(listViews("acc1")).toEqual([]);
	});

	it("write survives a throwing localStorage.setItem", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		expect(() => saveView("acc1", "Doomed", "#/waf")).not.toThrow();
	});
});

describe("isNavigableHash / navigateToView", () => {
	const routes = ["waf", "cache"];

	it("requires the #/ prefix", () => {
		expect(isNavigableHash("waf?zone=z", routes)).toBe(false);
		expect(isNavigableHash("#/waf?zone=z", routes)).toBe(true);
	});

	it("requires a known route", () => {
		expect(isNavigableHash("#/nonexistent", routes)).toBe(false);
	});

	it("navigates only when the hash validates", () => {
		const original = window.location.hash;
		try {
			navigateToView({ hash: "#/waf?zone=z1" }, routes);
			expect(window.location.hash).toBe("#/waf?zone=z1");

			window.location.hash = "";
			navigateToView({ hash: "#/nope" }, routes);
			expect(window.location.hash).toBe("");
		} finally {
			window.location.hash = original;
		}
	});
});

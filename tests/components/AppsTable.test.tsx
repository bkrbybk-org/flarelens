import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppsTable } from "../../web/src/features/access/AppsTable";
import type { CfApp } from "../../web/src/types";
import type { RuleContext } from "../../web/src/lib/rules";

// AppsTable is the table-driven page picked for column/search filtering coverage. The Excel-style
// per-column filter popover (ColumnFilterPopover, positioned via getBoundingClientRect) is not
// exercised here — jsdom's layout geometry is all zeroes, so asserting popover placement would be
// brittle without buying real regression protection. The global search box drives the same
// TanStack `getFilteredRowModel` filtering path and is what an operator actually types into first.
//
// AppsTable renders both a desktop <table> and a `md:hidden` mobile card list at the same time —
// the `md:` breakpoint is a CSS media query jsdom never evaluates, so both are always in the DOM.
// Assertions use getAllByText/queryAllByText rather than the singular form for that reason.

const ctx: RuleContext = {
	groupName: (id) => id,
	idpName: (id) => id,
};

function app(overrides: Partial<CfApp>): CfApp {
	return {
		id: overrides.id ?? "app",
		policies: [],
		policies_error: false,
		...overrides,
	};
}

const apps: CfApp[] = [
	app({ id: "a1", name: "Acme Widgets", domain: "acme.example.com" }),
	app({ id: "a2", name: "Bravo Systems", domain: "bravo.example.com" }),
	app({ id: "a3", name: "Charlie Corp", domain: "charlie.example.com" }),
];

function renderTable() {
	return render(
		<AppsTable
			apps={apps}
			loading={false}
			ctx={ctx}
			reusableMap={{}}
			onSelect={vi.fn()}
			perPage={25}
			density="comfortable"
			columnVisibility={{}}
			columnOrder={[]}
			onPrefsChange={vi.fn()}
		/>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AppsTable", () => {
	it("renders every app by default", () => {
		renderTable();
		expect(screen.getAllByText("Acme Widgets").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Bravo Systems").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Charlie Corp").length).toBeGreaterThan(0);
	});

	it("narrows the visible rows to the search match", async () => {
		const user = userEvent.setup();
		renderTable();

		await user.type(screen.getByPlaceholderText("Search applications…"), "acme");

		expect(screen.getAllByText("Acme Widgets").length).toBeGreaterThan(0);
		expect(screen.queryAllByText("Bravo Systems")).toHaveLength(0);
		expect(screen.queryAllByText("Charlie Corp")).toHaveLength(0);
	});

	it("restores every row once the search text is cleared", async () => {
		const user = userEvent.setup();
		renderTable();

		const search = screen.getByPlaceholderText("Search applications…");
		await user.type(search, "acme");
		expect(screen.queryAllByText("Bravo Systems")).toHaveLength(0);

		await user.clear(search);

		expect(screen.getAllByText("Acme Widgets").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Bravo Systems").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Charlie Corp").length).toBeGreaterThan(0);
	});
});

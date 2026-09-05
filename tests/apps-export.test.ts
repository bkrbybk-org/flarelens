import { describe, expect, it } from "vitest";
import { formatCellText } from "../web/src/features/access/AppsTable";
import { toCsv } from "../web/src/lib/csv";
import type { CfApp, CfPolicy } from "../web/src/types";
import type { RuleContext } from "../web/src/lib/rules";

// Regression coverage for the P2 bug: the Access Applications CSV export used
// to dump raw JSON (arrays, whole policy objects, ISO timestamps) instead of
// the human-readable text the table actually renders for each cell.

const ctx: RuleContext = {
	groupName: (id) => id,
	idpName: (id) => `idp-${id}`,
};

function app(overrides: Partial<CfApp>): CfApp {
	return {
		id: "app1",
		policies: [],
		policies_error: false,
		...overrides,
	};
}

describe("formatCellText", () => {
	it("renders a tags array as comma-joined text, not a JSON array", () => {
		const a = app({ tags: ["prod", "billing"] });
		expect(formatCellText("tags", a, ctx, {})).toBe("prod, billing");
	});

	it("renders policies as 'Name (decision)' summaries like the table does", () => {
		const policies: CfPolicy[] = [
			{ id: "p1", name: "P1", decision: "allow" },
			{ id: "p2", name: "P2", decision: "non_identity" },
		];
		const a = app({ policies });
		expect(formatCellText("policies", a, ctx, {})).toBe("P1 (allow), P2 (non identity)");
	});

	it("resolves reusable (id-only) policies via the reusable map before formatting", () => {
		const reusableMap: Record<string, CfPolicy> = { shared1: { id: "shared1", name: "Shared", decision: "deny" } };
		const a = app({ policies: [{ id: "shared1" }] });
		expect(formatCellText("policies", a, ctx, reusableMap)).toBe("Shared (deny)");
	});

	it("renders policies_error as the same text the ErrorBadge shows", () => {
		const a = app({ policies_error: true });
		expect(formatCellText("policies", a, ctx, {})).toBe("Policies unavailable");
	});

	it("formats a date column the same way the table displays it", () => {
		const a = app({ updated_at: "2026-07-01T17:00:00Z" });
		const text = formatCellText("updated_at", a, ctx, {});
		// exact wall-clock text is timezone-dependent in CI, but it must not be
		// the raw ISO string and must follow the DD-Mon-YYYY HH:MM shape
		expect(text).not.toBe("2026-07-01T17:00:00Z");
		expect(text).toMatch(/^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}$/);
	});

	it("exports an empty/missing value as an empty string, not 'undefined'", () => {
		const a = app({ name: undefined });
		expect(formatCellText("name", a, ctx, {})).toBe("");
		const b = app({});
		expect(formatCellText("session_duration", b, ctx, {})).toBe("");
	});

	it("joins allowed_idps and destinations the same way the rendered chips read", () => {
		const a = app({ allowed_idps: ["a", "b"], destinations: [{ uri: "foo.example.com" }, { hostname: "bar.example.com" }] });
		expect(formatCellText("allowed_idps", a, ctx, {})).toBe("idp-a, idp-b");
		expect(formatCellText("destinations", a, ctx, {})).toBe("foo.example.com, bar.example.com");
	});

	it("survives a comma/quote-bearing policy name through toCsv with proper RFC-4180 quoting", () => {
		const a = app({ policies: [{ id: "p1", name: 'Sales, "EU"', decision: "allow" }] });
		const csv = toCsv([a], [{ header: "Policies", value: (row) => formatCellText("policies", row, ctx, {}) }]);
		expect(csv).toBe('Policies\r\n"Sales, ""EU"" (allow)"');
	});
});

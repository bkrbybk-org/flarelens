import { describe, expect, it } from "vitest";
import { formatErrorDetails } from "../web/src/components/ErrorBoundary";

// Only the pure formatting helper is testable here: the vitest environment is
// "node" with no jsdom/@testing-library, so the class component itself
// (which needs to mount and throw) can't be exercised meaningfully.
describe("formatErrorDetails", () => {
	it("includes the error name, message, and stack", () => {
		const error = new Error("boom");
		error.stack = "Error: boom\n    at somewhere.ts:1:1";

		const details = formatErrorDetails(error, "");

		expect(details).toContain("Error: boom");
		expect(details).toContain("at somewhere.ts:1:1");
	});

	it("appends the component stack when present", () => {
		const error = new Error("boom");
		const details = formatErrorDetails(error, "\n    in Widget\n    in App");

		expect(details).toContain("Component stack:");
		expect(details).toContain("in Widget");
	});

	it("falls back to a generic label when there is no error", () => {
		expect(formatErrorDetails(null, "")).toBe("Unknown error");
	});
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `npm run build` copies the Swagger UI bundles into web/public/docs/. They are vendor code and
 * gitignored, but ESLint has no notion of gitignore — after a build it linted them and reported
 * thousands of errors, which is how CI (build, then lint) broke. The ignore must stay.
 */
describe("lint configuration", () => {
	it("ignores the copied Swagger UI bundles", () => {
		const config = readFileSync(join(import.meta.dirname, "..", "eslint.config.js"), "utf8");
		expect(config).toContain('"web/public/docs/"');
	});
});

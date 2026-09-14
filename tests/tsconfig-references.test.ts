import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `tests/` is type-checked only because the root tsconfig's `references` point at
 * `tests/tsconfig.json` (the node project) and `tests/components/tsconfig.json` (the jsdom/React
 * project) — `tsc -b` walks references, so it has no other way to discover them. Nothing else
 * enforces that link: dropping a reference here leaves `npm run check` green while `tests/`
 * silently falls out of type-checking again, which is the exact regression this guards against.
 */

const root = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tsconfig.json"), "utf8")) as {
	references?: { path: string }[];
};

describe("root tsconfig keeps tests type-checked", () => {
	it("still references both tests projects", () => {
		const paths = (root.references ?? []).map((r) => r.path);
		expect(paths).toContain("./tests/tsconfig.json");
		expect(paths).toContain("./tests/components/tsconfig.json");
	});
});

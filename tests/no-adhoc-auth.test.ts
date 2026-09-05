import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardrail: credential resolution must stay in one place.
 *
 * Every /api/* route needs the same two checks — is this caller authorised, and is the account
 * or zone they asked for one this deployment may touch. A route that reads the Authorization
 * header itself skips both, and on a deployment with a bound CF_API_TOKEN that is the whole
 * security boundary. This test pins where such reads are allowed to appear, so a new route
 * growing its own token plumbing fails the suite by name instead of shipping quietly.
 *
 * The budget is empty and must stay that way: every route goes through resolveAuth.
 */

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const AUTH_MODULE = join("src", "lib", "auth.ts");

/** Direct reads of the caller's Authorization header, outside the auth module. */
const ADHOC_AUTH_BUDGET: Record<string, number> = {};

const AUTH_HEADER_READ = /header\(\s*["']Authorization["']\s*\)|headers\.get\(\s*["']Authorization["']\s*\)/g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return sourceFiles(full);
		return full.endsWith(".ts") ? [full] : [];
	});
}

describe("credential resolution stays centralised", () => {
	it("has no ad-hoc Authorization reads beyond the pinned budget", () => {
		const found: Record<string, number> = {};

		for (const file of sourceFiles(SOURCE_ROOT)) {
			const relative = file.slice(file.indexOf("src"));
			if (relative === AUTH_MODULE) continue;
			const count = (readFileSync(file, "utf8").match(AUTH_HEADER_READ) || []).length;
			if (count > 0) found[relative] = count;
		}

		expect(found).toEqual(ADHOC_AUTH_BUDGET);
	});

	it("keeps the Access JWT header out of route code", () => {
		// Only src/lib/auth.ts may look at the Access assertion, and only after verifying it.
		// A route trusting the header's presence would accept a spoofed one off-path.
		for (const file of sourceFiles(SOURCE_ROOT)) {
			const relative = file.slice(file.indexOf("src"));
			if (relative === AUTH_MODULE) continue;
			const source = readFileSync(file, "utf8");
			expect(source, `${relative} must not read Access headers directly`).not.toMatch(
				/Cf-Access-Jwt-Assertion|Cf-Access-Authenticated-User-Email/i,
			);
		}
	});

	it("never returns the bound token to a client", () => {
		for (const file of sourceFiles(SOURCE_ROOT)) {
			const relative = file.slice(file.indexOf("src"));
			const source = readFileSync(file, "utf8");
			// c.json({ token: env.CF_API_TOKEN }) and friends. The mode may be published; the
			// value may not.
			expect(source, `${relative} must not serialise CF_API_TOKEN`).not.toMatch(
				/(json|stringify)\([^)]*CF_API_TOKEN/,
			);
		}
	});
});

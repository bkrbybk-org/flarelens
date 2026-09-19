import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, isSessionError } from "../web/src/api/client";

describe("isSessionError", () => {
	it("ends the session only on a 401", () => {
		expect(isSessionError(new ApiError("x", 401))).toBe(true);
		expect(isSessionError(new ApiError("Authentication error", 403))).toBe(false);
		expect(isSessionError(new ApiError("x", 502))).toBe(false);
		expect(isSessionError(new Error("x"))).toBe(false);
	});
});

describe("no loader treats a 403 as a dead session", () => {
	// A 403 is a permission answer about one read — an optional scope the token lacks. Routes
	// pass Cloudflare's 403 through, so a loader that disconnects on it logs the operator out for
	// opening a section. Every loader must decide through isSessionError instead.
	function files(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
		});
	}

	it("ends the session only under an isSessionError check", () => {
		const offenders: string[] = [];
		for (const path of files(join(__dirname, "../web/src"))) {
			const lines = readFileSync(path, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (!/onAuthError(Ref\.current)?\(\)/.test(line)) return;
				const guard = lines.slice(Math.max(0, i - 3), i).join("\n");
				if (!guard.includes("isSessionError(")) offenders.push(`${path}:${i + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});
});

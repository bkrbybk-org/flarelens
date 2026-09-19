/**
 * Mirrors `compareCloudflaredVersions` in src/lib/cloudflared-version.ts. Duplicated rather than
 * shared because the web app and the Worker are separate TypeScript projects (see web/tsconfig.json,
 * which only includes web/src) — this is presentation-only (badge coloring), not a security check,
 * so drift risk is low and is caught by the server-side unit tests for the real comparison.
 */

interface ParsedVersion {
	year: number;
	month: number;
	patch: number;
}

function parse(raw: string): ParsedVersion | null {
	const match = /^v?(\d{4})\.(\d{1,2})\.(\d+)$/.exec(String(raw || "").trim());
	if (!match) return null;
	const [, year, month, patch] = match;
	return { year: Number(year), month: Number(month), patch: Number(patch) };
}

/** -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`; null if either side doesn't parse as `YYYY.M.P`. */
export function compareCloudflaredVersions(a: string, b: string): -1 | 0 | 1 | null {
	const va = parse(a);
	const vb = parse(b);
	if (!va || !vb) return null;
	if (va.year !== vb.year) return va.year < vb.year ? -1 : 1;
	if (va.month !== vb.month) return va.month < vb.month ? -1 : 1;
	if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
	return 0;
}

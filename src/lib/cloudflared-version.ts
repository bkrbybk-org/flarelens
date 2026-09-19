/**
 * Comparing connector `cloudflared` versions against the latest GitHub release.
 *
 * cloudflared tags releases `YYYY.M.P` (e.g. "2026.9.1") — a calendar year, a month (1-12,
 * NOT zero-padded), and a patch counter. This is not semver: string comparison sorts "2026.9.1"
 * after "2026.10.1" because "9" > "1" lexically, so every comparison here is numeric.
 */

export interface CloudflaredVersion {
	year: number;
	month: number;
	patch: number;
}

/** Parses a `cloudflared` version string, tolerant of a leading "v" some tags carry. */
export function parseCloudflaredVersion(raw: string): CloudflaredVersion | null {
	const cleaned = String(raw || "").trim().replace(/^v/i, "");
	const match = /^(\d{4})\.(\d{1,2})\.(\d+)$/.exec(cleaned);
	if (!match) return null;
	const [, year, month, patch] = match;
	return { year: Number(year), month: Number(month), patch: Number(patch) };
}

/** -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`. Either side unparsed returns null — not a claim. */
export function compareCloudflaredVersions(a: string, b: string): -1 | 0 | 1 | null {
	const va = parseCloudflaredVersion(a);
	const vb = parseCloudflaredVersion(b);
	if (!va || !vb) return null;
	if (va.year !== vb.year) return va.year < vb.year ? -1 : 1;
	if (va.month !== vb.month) return va.month < vb.month ? -1 : 1;
	if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
	return 0;
}

/**
 * Whole months between two `YYYY.M.P` versions, treating each release as the first of its month.
 * Used only to decide "how far behind", never to render a calendar date — patch releases within
 * the same month are 0 months apart even though they are not the same release.
 */
export function monthsBetween(older: CloudflaredVersion, newer: CloudflaredVersion): number {
	return (newer.year - older.year) * 12 + (newer.month - older.month);
}

export type LatestCloudflared = { version: string; publishedAt: string } | { error: string };

const GITHUB_RELEASE_URL = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

/**
 * Fetches the latest `cloudflared` GitHub release, tolerant of any failure (rate limit, network,
 * malformed body): the caller always gets a value, never a thrown error, because this must never
 * take the tunnel map down with it.
 */
export async function fetchLatestCloudflaredRelease(): Promise<LatestCloudflared> {
	try {
		const response = await fetch(GITHUB_RELEASE_URL, {
			headers: { "User-Agent": "flarelens", Accept: "application/vnd.github+json" },
		});
		if (!response.ok) {
			return { error: `GitHub returned HTTP ${response.status}` };
		}
		const body = (await response.json()) as { tag_name?: string; published_at?: string; prerelease?: boolean };
		const version = parseCloudflaredVersion(body.tag_name || "");
		if (!version || !body.published_at) {
			return { error: "GitHub release response was missing a recognizable version" };
		}
		return { version: body.tag_name as string, publishedAt: body.published_at };
	} catch (err) {
		return { error: err instanceof Error ? err.message : "Failed to reach GitHub" };
	}
}

const GITHUB_CACHE_KEY = "https://flarelens.internal/api-cache/v1/public/cloudflared-latest";
const GITHUB_CACHE_TTL_SECONDS = 3600;

/**
 * `fetchLatestCloudflaredRelease` behind a 1-hour edge cache.
 *
 * This is public data (a GitHub release tag), not scoped to any caller's credential, so the key
 * is fixed rather than namespaced by `tokenFingerprint` like the rest of edge-cache.ts — there is
 * no per-tenant secret to leak by sharing one entry across every caller of this Worker.
 */
export async function getLatestCloudflaredCached(waitUntil: (p: Promise<unknown>) => void): Promise<LatestCloudflared> {
	const cache: { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> } | null =
		typeof caches !== "undefined" && caches?.default ? caches.default : null;

	if (cache) {
		try {
			const hit = await cache.match(GITHUB_CACHE_KEY);
			if (hit) {
				const stored = (await hit.json()) as LatestCloudflared | null;
				if (stored && ("version" in stored || "error" in stored)) return stored;
			}
		} catch {
			// Corrupt or unavailable cache entry — fall through to a live fetch below.
		}
	}

	const result = await fetchLatestCloudflaredRelease();

	// Only cache a successful lookup: an "error" result (e.g. rate-limited) should be retried on
	// the next request rather than pinned as the answer for an hour.
	if (cache && "version" in result) {
		try {
			waitUntil(
				cache
					.put(
						GITHUB_CACHE_KEY,
						new Response(JSON.stringify(result), {
							headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${GITHUB_CACHE_TTL_SECONDS}` },
						}),
					)
					.catch(() => {}),
			);
		} catch {
			// cache.put threw synchronously — same rule, swallow it.
		}
	}

	return result;
}

/** ~6 calendar months behind is the line between "info: an update exists" and "warn: quite stale". */
export const STALE_MONTHS_THRESHOLD = 6;

export interface VersionComparisonNote {
	level: "warn" | "info";
	message: string;
}

/**
 * Builds the "behind latest" health note for one connector, or null when it is current, unparsable,
 * or the latest release itself could not be determined (never invent a finding from missing data).
 */
export function versionBehindNote(connectorVersion: string, latest: LatestCloudflared): VersionComparisonNote | null {
	if ("error" in latest) return null;
	const cmp = compareCloudflaredVersions(connectorVersion, latest.version);
	if (cmp === null || cmp >= 0) return null;
	const current = parseCloudflaredVersion(connectorVersion);
	const target = parseCloudflaredVersion(latest.version);
	if (!current || !target) return null;
	const months = monthsBetween(current, target);
	const behindText = months > 0 ? `, about ${months} month${months === 1 ? "" : "s"} behind` : "";
	const level = months >= STALE_MONTHS_THRESHOLD ? "warn" : "info";
	return {
		level,
		message: `Running cloudflared ${connectorVersion}; latest is ${latest.version}${behindText}.`,
	};
}

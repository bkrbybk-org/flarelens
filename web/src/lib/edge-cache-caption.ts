/**
 * Caption text for a section whose data came from the Worker's short-lived edge cache.
 *
 * A zero and an absence must never look the same, and neither must cached and live data — this
 * string is the one place that distinction reaches the reader, so callers must render it whenever
 * `cachedAt` is non-null and never fabricate an age when it is null (live).
 */
export function cacheAgeLabel(cachedAt: string): string {
	const then = new Date(cachedAt).getTime();
	const seconds = Number.isFinite(then) ? Math.max(0, Math.round((Date.now() - then) / 1000)) : 0;
	const age = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
	return `Showing data cached ${age} ago — Sync for a fresh read`;
}

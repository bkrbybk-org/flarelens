/**
 * Caption text for a section whose data came from the Worker's short-lived edge cache.
 *
 * A zero and an absence must never look the same, and neither must cached and live data — this
 * string is the one place that distinction reaches the reader, so callers must render it whenever
 * `cachedAt` is non-null and never fabricate a time when it is null (live).
 *
 * States the clock time the data was cached rather than an age. An age ("cached 3s ago") is
 * computed once when the page renders and then sits on screen unchanged, so a few minutes later
 * it is simply untrue. A clock time stays correct however long the page is left open.
 */
export function cacheAgeLabel(cachedAt: string): string {
	const then = new Date(cachedAt);
	if (!Number.isFinite(then.getTime())) return "Showing cached data — Sync for a fresh read";
	const clock = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	return `Showing data cached at ${clock} — Sync for a fresh read`;
}

import type { Zone } from '../cf/types';
import { PII_CATEGORIES, UNSAFE_TOPICS } from './catalog';

/**
 * All user input is validated against fixed enums / the known zone list before it can
 * influence a GraphQL query. The dashboard is unauthenticated, so nothing the client
 * sends may reach the Cloudflare API as free text.
 */

/**
 * Relative presets. Insertion order is render order in the top-bar <select>, so keep them
 * ascending. The bucket is NOT stored here — it is derived from the span by bucketFor(), so
 * that a hand-picked custom window of the same length gets the same granularity as a preset.
 * Two bucket rules would let "Last 24 hours" and a hand-picked 24-hour window disagree.
 */
export const RANGES = {
	'30m': { label: 'Last 30 min', minutes: 30 },
	'1h': { label: 'Last hour', minutes: 60 },
	'3h': { label: 'Last 3 hours', minutes: 180 },
	'6h': { label: 'Last 6 hours', minutes: 360 },
	'12h': { label: 'Last 12 hours', minutes: 720 },
	'24h': { label: 'Last 24 hours', minutes: 1440 },
	'7d': { label: 'Last 7 days', minutes: 10080 },
	'30d': { label: 'Last 30 days', minutes: 43200 },
} as const;

/**
 * Span thresholds -> GraphQL time-series dimension, fine to coarse. `stepMinutes` is the width
 * of one bucket in that dimension.
 *
 * The thresholds are 120/720/20160 rather than round numbers because they are chosen to
 * reproduce every pre-existing preset's bucket exactly: 30m -> five-minute, 6h -> fifteen-minute,
 * 24h and 7d -> hour, 30d -> date. A test pins that. Do NOT reimplement this as "finest bucket
 * that stays under N points" — that picks five-minute for the 6h preset and silently changes a
 * chart that has been correct for months.
 *
 * Every name here must be one `bucketTs()` in domain/transform.ts truncates, and one the schema
 * probe found on httpRequestsAdaptiveGroups; a name outside that set falls through bucketTs's
 * default and is silently truncated to the hour. Tests assert both directions.
 *
 * Worst case under the 30-day lookback cap is a 14-day window at hourly = 336 buckets, well
 * inside the `limit: 1000` on the series aliases in cf/queries.ts.
 */
export const BUCKET_STEPS = [
	{ maxMinutes: 120, dimension: 'datetimeFiveMinutes', stepMinutes: 5 },
	{ maxMinutes: 720, dimension: 'datetimeFifteenMinutes', stepMinutes: 15 },
	{ maxMinutes: 20160, dimension: 'datetimeHour', stepMinutes: 60 },
	{ maxMinutes: Number.POSITIVE_INFINITY, dimension: 'date', stepMinutes: 1440 },
] as const;

/** Time-series bucket dimension for a window of `spanMinutes`. */
export function bucketFor(spanMinutes: number): string {
	return (BUCKET_STEPS.find((s) => spanMinutes <= s.maxMinutes) ?? BUCKET_STEPS[BUCKET_STEPS.length - 1]).dimension;
}

export type RangeKey = keyof typeof RANGES;
export const DEFAULT_RANGE: RangeKey = '24h';

export const DETECTION_TYPES = {
	all: 'All detections',
	injection: 'Prompt injection',
	pii: 'PII in prompt',
	unsafe: 'Unsafe topic',
	custom: 'Custom topic',
} as const;

export type DetectionType = keyof typeof DETECTION_TYPES;

/**
 * Grouping key for the "Attacker sessions" table. 'ip' is the original, default behaviour.
 * 'ja4' groups by TLS client fingerprint instead, so a campaign that rotates source IPs still
 * collapses into one row. Defined here (not in domain/transform.ts, which builds the table)
 * because DashboardParams — the parsed, validated request shape — needs it too, and
 * transform.ts already imports its sibling DetectionType from this file the same way.
 */
export const SESSION_KEYS = {
	ip: 'Source IP',
	ja4: 'JA4 fingerprint',
	asn: 'ASN',
} as const;

export type SessionKey = keyof typeof SESSION_KEYS;
export const DEFAULT_SESSION_KEY: SessionKey = 'ip';

/**
 * How the "Targeted endpoints" table groups its rows.
 *
 * `target` (host + path) is the original and stays the default — it is the level a WAF rule is
 * usually written at. The other two answer questions the combined key cannot: "which host is
 * taking the abuse" when one zone fronts several, and "which route is weak across all of them"
 * when the same path is mounted on many hosts.
 */
export const ENDPOINT_KEYS = {
	target: 'Host + path',
	host: 'Host',
	path: 'Path',
} as const;

export type EndpointKey = keyof typeof ENDPOINT_KEYS;
export const DEFAULT_ENDPOINT_KEY: EndpointKey = 'target';

/** Auto-refresh cadence offered in the UI, in seconds. `0` means off. */
export const REFRESH_INTERVALS = [0, 30, 60, 90] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];
/** Off by default: an unattended reload wipes decrypted prompts and the in-memory key. */
export const DEFAULT_REFRESH: RefreshInterval = 0;

/**
 * Lookback cap for a custom window. No Cloudflare data-retention limit for
 * httpRequestsAdaptive / httpRequestsAdaptiveGroups / firewallEventsAdaptive is documented
 * anywhere in this repo or in the schema probe — the probe only ever proves which *fields*
 * resolve, never how far back they hold data. 30 days is the largest span demonstrably
 * working against this account, because the `30d` preset uses it. Raise it only together
 * with a preset, and only after measuring where counts actually go to zero.
 */
export const MAX_LOOKBACK_MINUTES = 43_200;
/** Below this a window is almost certainly a mis-click, and the chart would have one bucket. */
export const MIN_SPAN_MINUTES = 5;
/**
 * Custom bounds snap to this grid. At minute precision, start x end over 30 days is ~10^9
 * distinct cache keys, and every miss issues a real GraphQL fan-out across every zone. The
 * grid cuts that 25x. `step={300}` on the picker inputs keeps the browser offering only
 * values the server will accept, so the two never disagree about what a valid instant is.
 */
export const GRID_MINUTES = 5;

export interface TimeWindow {
	/** A preset key, or 'custom' for an absolute window. */
	key: RangeKey | 'custom';
	label: string;
	/** Bucketing dimension for time series. */
	bucket: string;
	start: string;
	end: string;
	/** Same-length window immediately before `start`, for period-over-period deltas. */
	prevStart: string;
	prevEnd: string;
}

/**
 * Server-side narrowing of the event list, sent as `n.<key>` and applied in memory before
 * the row limit is taken. Keys deliberately mirror the client-side `f.<key>` column filters
 * one-for-one so a single drill-down link can carry both — see eventsHref() in views/links.ts.
 *
 * Why this exists: overview breakdowns are computed from every fetched row (up to 2000 per
 * detection type per zone) while /events renders only the newest `limit` (max 200), and the
 * `f.*` filters run in the browser against rendered rows only. A rare category counted from
 * row 1500 therefore produced a link to a page that never rendered it — measured at 41% of
 * emitted links dead on live traffic. Narrowing server-side slices the right 200 instead.
 */
export const NARROW_KEYS = ['piiVals', 'unsafeVals', 'customVals', 'ip', 'target', 'host', 'path', 'country', 'ja4', 'mitigated'] as const;
export type NarrowKey = (typeof NARROW_KEYS)[number];
/**
 * Values are comma-separated in the URL and OR together within a key; keys AND with each other.
 * That mirrors the client-side `f.<key>` pickers exactly, which is the point — a drill-down link
 * emits both halves from one input, so the two must agree on what "several values" means.
 *
 * A key present with values is a filter; a key whose values all fail validation is dropped
 * entirely rather than left as an empty array, so an unparseable link narrows to nothing the same
 * way it always did instead of matching every row.
 *
 * Comma is the separator and is therefore not usable *inside* a value. None of the vocabularies
 * contain one — the PII and unsafe-topic labels are catalog-controlled, `country` is two letters,
 * `ip` and `ja4` are token shapes — so the only theoretical loser is a `target` path containing a
 * literal comma, which would split into parts that fail validation and drop the filter.
 */
export type EventNarrow = Partial<Record<NarrowKey, string[]>>;

/**
 * Cap on values per narrowing key. Each one widens the result set and lengthens the cache key,
 * and eight is already more categories than any drill-down emits — the pickers exist for
 * hand-built selections that go beyond it.
 */
export const MAX_NARROW_VALUES = 8;

export interface DashboardParams {
	range: TimeWindow;
	/** Selected zone tag, or null for the account-wide rollup. */
	zoneId: string | null;
	detection: DetectionType;
	/** Page auto-refresh cadence in seconds. */
	refresh: RefreshInterval;
	limit: number;
	/** Validated server-side event narrowing. Empty object when no `n.*` param was supplied. */
	narrow: EventNarrow;
	/** Requested "Attacker sessions" grouping key. May be downgraded by the caller if the
	 * schema cannot back it (see hasJa4Field() in index.tsx) — this is the raw request. */
	sessionKey: SessionKey;
	/** How the "Targeted endpoints" table groups — host+path, host alone, or path alone. */
	endpointKey: EndpointKey;
	/**
	 * True for `?compare=prev`: overlay the previous period on the traffic chart.
	 *
	 * A boolean rather than a set of modes because there is exactly one comparison the data
	 * supports without a second fetch — `prevStart..prevEnd` is already computed for the KPI
	 * deltas, so "previous period" is free while "same day last week" would be a new window and
	 * a new round trip. Adding modes later means changing this type, which is the right place to
	 * feel that cost.
	 */
	compare: boolean;
	/** Original query string, normalized — used as the cache key. */
	cacheKey: string;
}

function isRangeKey(v: string | undefined): v is RangeKey {
	return !!v && v in RANGES;
}

function isDetectionType(v: string | undefined): v is DetectionType {
	return !!v && v in DETECTION_TYPES;
}

function isEndpointKey(v: string | undefined): v is EndpointKey {
	return !!v && v in ENDPOINT_KEYS;
}

function isSessionKey(v: string | undefined): v is SessionKey {
	return !!v && v in SESSION_KEYS;
}

function isRefreshInterval(v: number): v is RefreshInterval {
	return (REFRESH_INTERVALS as readonly number[]).includes(v);
}

export function buildWindow(key: RangeKey, now = new Date()): TimeWindow {
	const { minutes, label } = RANGES[key];
	const bucket = bucketFor(minutes);
	const ms = minutes * 60_000;
	// Analytics data lags slightly; end at "now" and accept the last bucket being partial.
	const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
	const start = new Date(end.getTime() - ms);
	const prevEnd = start;
	const prevStart = new Date(start.getTime() - ms);
	return {
		key,
		label,
		bucket,
		start: start.toISOString(),
		end: end.toISOString(),
		prevStart: prevStart.toISOString(),
		prevEnd: prevEnd.toISOString(),
	};
}

/**
 * Narrowing values are the rendered *display labels*, not API codes — the same vocabulary the
 * `f.*` client filters use, because events.tsx writes `piiLabel(code)` into `data-pii-vals`.
 * Keeping one vocabulary for both halves of a drill-down link is what stops the two from
 * drifting apart; the round-trip assertion in scripts/test-domain.mjs pins it.
 */
const PII_LABELS = new Set(Object.values(PII_CATEGORIES).map((c) => c.name));
const UNSAFE_LABELS = new Set(Object.values(UNSAFE_TOPICS).map((c) => c.name));

/**
 * Bounded free-text guard for the three narrowing keys that have no catalog to check against:
 * custom topic labels are defined by the customer in their own rules, and IPs and host+path
 * targets are drawn from live traffic. None of them can be enum-validated the way `pii` and
 * `unsafe` are.
 *
 * This is safe *because the value never reaches a GraphQL query* — narrowing is applied by
 * comparing against rows already fetched into memory, so there is no injection surface. The
 * only thing the guard has to bound is response-cache fragmentation, since these values now
 * appear in `cacheKey`. A length cap does that; combined with the 30–60s TTL the blast radius
 * is a handful of extra entries.
 *
 * Control characters are rejected outright: U+001F is the separator events.tsx uses to join
 * multi-value attributes, so letting one through would corrupt the comparison.
 */
function boundedText(value: string, maxLength: number): string | null {
	if (value.length === 0 || value.length > maxLength) return null;
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	return value;
}

function validateNarrowValue(key: NarrowKey, value: string): string | null {
	switch (key) {
		case 'piiVals':
			return PII_LABELS.has(value) ? value : null;
		case 'unsafeVals':
			return UNSAFE_LABELS.has(value) ? value : null;
		case 'customVals':
			// Customer-defined topic labels; observed values are short kebab-case strings.
			return boundedText(value, 64);
		case 'ip':
			// Deliberately a shape guard rather than a strict v4/v6 parser: the value is only
			// ever string-compared against an already-fetched row, so rejecting an address form
			// this codebase failed to anticipate would cost a working drill-down for no gain.
			return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : null;
		case 'target':
			// host + path, as rendered into data-target.
			return boundedText(value, 512);
		case 'host':
			// Hostname alone. Same bounded-text guard as `target` rather than a hostname regex: the
			// value is only ever string-compared against a row already in memory, so rejecting a
			// legitimate punycode or trailing-dot form would cost a working filter for no gain.
			return boundedText(value, 253);
		case 'path':
			// Path alone, matched exactly as rendered — no prefix or glob semantics, because the
			// events table's own column filter is an equality picker and the two must agree.
			return boundedText(value, 512);
		case 'country':
			// ISO alpha-2 code, as rendered into data-country. Unlike the free-text keys above,
			// this one has a fixed shape, so it can be tightly validated rather than just bounded.
			// Uppercase before comparing so a lowercase link (or a hand-typed URL) still works.
			return /^[a-zA-Z]{2}$/.test(value) ? value.toUpperCase() : null;
		case 'ja4':
			// JA4 fingerprints are a fixed-format token (e.g. "t13d1516h2_8daaf6152771_02713d6af862"),
			// but the exact character set Cloudflare emits isn't documented anywhere in this repo, so
			// this is a bounded free-text guard like customVals rather than a format regex — same
			// reasoning as `ip` above. Observed values sit well under 64 chars.
			return boundedText(value, 64);
		case 'mitigated':
			// Not a column on the events table — there is no matching `f.mitigated` for the client
			// filter to restore, and no vocabulary to grow. Exactly 'true'/'false', matching
			// isTerminated(e) in transform.ts, which is the only thing that decides the value.
			return value === 'true' || value === 'false' ? value : null;
	}
}

export function parseNarrow(url: URL): EventNarrow {
	const narrow: EventNarrow = {};
	for (const key of NARROW_KEYS) {
		// getAll() as well as the comma split, so both `n.ip=a&n.ip=b` and `n.ip=a,b` work. The
		// repeated-param form used to keep only the first value silently.
		const raw = url.searchParams.getAll(`n.${key}`);
		if (!raw.length) continue;
		const values: string[] = [];
		for (const part of raw.flatMap((r) => r.split(','))) {
			const valid = validateNarrowValue(key, part);
			// Deduped: a repeated value would only lengthen the cache key, since matching is OR.
			if (valid !== null && !values.includes(valid)) values.push(valid);
			if (values.length === MAX_NARROW_VALUES) break;
		}
		if (values.length) narrow[key] = values;
	}
	return narrow;
}

/**
 * Stable serialization so two equivalent narrowings share one cache entry. Both levels are
 * sorted — keys by NARROW_KEYS order, values alphabetically — because `n.ip=a,b` and `n.ip=b,a`
 * select exactly the same rows and must not render twice into two cache entries.
 *
 * Every value is percent-encoded, and that is a correctness requirement rather than tidiness.
 * The cache key is interpolated into a URL in cached() (index.tsx), and the free-text keys accept
 * the very characters that structure one. Unencoded, two *different* requests could serialize to
 * a byte-identical key: `n.target=a&n.country=SG` and the single crafted value
 * `n.target=a|country=SG` both produced
 *   narrow=target=a|country=SG
 * so whichever rendered first was served to the other — the second request showing rows its own
 * filter excludes. A literal `#` was worse: everything after it is a URL fragment, so it fell out
 * of the cache key entirely and every value sharing a prefix collided. Encoding closes both,
 * because `|`, `&`, `=` and `#` can no longer survive into the key as separators.
 */
function narrowCacheKey(narrow: EventNarrow): string {
	const parts = NARROW_KEYS.filter((k) => narrow[k]?.length).map(
		(k) => `${k}=${[...narrow[k]!].sort().map(encodeURIComponent).join(',')}`,
	);
	return parts.length ? `&narrow=${parts.join('|')}` : '';
}

/**
 * True for an absolute (custom) window. Derived from `key` rather than stored as its own
 * field, so there is exactly one encoding of the fact and nothing to drift out of sync.
 */
export function isAbsolute(win: TimeWindow): boolean {
	return win.key === 'custom';
}

/**
 * Parse one bound of a custom range into epoch ms, or null if it is not acceptable.
 *
 * This is the security boundary. Everywhere else in this file, user input is checked against
 * a fixed enum or the known zone list; a date is the first value that cannot be. It matters
 * because cf/queries.ts interpolates win.start/win.end DIRECTLY into the GraphQL query string
 * — safe only because every TimeWindow field is produced by toISOString(), never by carrying
 * user text through.
 *
 * The `Z` is mandatory in meaning, optional in syntax. A bare `YYYY-MM-DDTHH:MM` — exactly
 * what <input type="datetime-local"> submits — is spec-mandated to parse as LOCAL time:
 *
 *     TZ=UTC              new Date('2026-08-12T10:30') -> 2026-08-12T10:30:00.000Z
 *     TZ=Asia/Bangkok     new Date('2026-08-12T10:30') -> 2026-08-12T03:30:00.000Z
 *     TZ=America/New_York new Date('2026-08-12T10:30') -> 2026-08-12T14:30:00.000Z
 *
 * On a Worker local === UTC, so treating the bare form as local would look correct in
 * production while making this repo's tests depend on the developer's TZ. The picker is
 * therefore labelled UTC and its value is normalised to a `Z` instant here.
 *
 * An explicit offset (`+07:00`) is rejected rather than honoured: one wire format with one
 * meaning is easier to reason about than two, and nothing we emit produces that form.
 */
export function parseIsoMinute(raw: string): number | null {
	// Bound the work before touching a regex or the Date parser at all.
	if (raw.length > 40) return null;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?Z?$/.test(raw)) return null;
	const ms = Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
	return Number.isFinite(ms) ? ms : null;
}

function snapToGrid(ms: number): number {
	const grid = GRID_MINUTES * 60_000;
	return Math.round(ms / grid) * grid;
}

function isoMinuteLabel(iso: string): string {
	return iso.slice(0, 16).replace('T', ' ');
}

/**
 * Absolute window between two already-validated instants. Both bounds snap to the grid, and
 * every timestamp leaves through toISOString() so the invariant cf/queries.ts relies on holds
 * for custom windows exactly as it does for preset ones.
 *
 * The previous period is the same span immediately before `start`, matching buildWindow. For a
 * window at the far end of the lookback cap that reaches ~60 days back, past whatever retention
 * actually is — harmless, because KpiTile suppresses the delta when the previous value is 0 and
 * renders "no prior-period baseline" instead. Do not "fix" it by suppressing the prev aliases.
 */
export function buildCustomWindow(startMs: number, endMs: number): TimeWindow {
	const start = snapToGrid(startMs);
	const end = snapToGrid(endMs);
	const span = end - start;
	const startIso = new Date(start).toISOString();
	const endIso = new Date(end).toISOString();
	return {
		key: 'custom',
		label: `${isoMinuteLabel(startIso)} → ${isoMinuteLabel(endIso)} UTC`,
		bucket: bucketFor(span / 60_000),
		start: startIso,
		end: endIso,
		prevStart: new Date(start - span).toISOString(),
		prevEnd: startIso,
	};
}

/**
 * Validate `?range=custom&start=…&end=…`, or null to fall through to the preset path.
 *
 * `range=custom` must be selected explicitly — a custom window is never inferred from the mere
 * presence of start/end. The top-bar filter form submits the range <select> AND both datetime
 * inputs on every submission, so inferring would mean picking "Last 6 hours" while stale values
 * sat in the inputs silently kept the old window.
 */
function parseCustomWindow(url: URL, now: Date): TimeWindow | null {
	if (url.searchParams.get('range') !== 'custom') return null;

	const startMs = parseIsoMinute(url.searchParams.get('start') ?? '');
	const endMs = parseIsoMinute(url.searchParams.get('end') ?? '');
	if (startMs === null || endMs === null) return null;

	// Compare against the floored now, matching buildWindow. Against an unfloored now a value
	// at the current minute reads as up to 59 seconds in the future and is wrongly rejected.
	const nowFloor = Math.floor(now.getTime() / 60_000) * 60_000;
	if (startMs >= endMs) return null;
	if (endMs > nowFloor) return null;
	if (endMs - startMs < MIN_SPAN_MINUTES * 60_000) return null;
	if (startMs < nowFloor - MAX_LOOKBACK_MINUTES * 60_000) return null;
	// A span longer than the cap needs no separate check: it is implied by end <= now and
	// start >= now - MAX_LOOKBACK.

	return buildCustomWindow(startMs, endMs);
}

export function parseParams(url: URL, zones: Zone[], now = new Date()): DashboardParams {
	// A rejected custom window falls through to the preset path and lands on DEFAULT_RANGE,
	// matching how every other invalid input in this file degrades: silently, to something
	// safe, rather than erroring. That is deliberate — the dashboard must not 500 on a
	// hand-edited or stale URL.
	const rangeParam = url.searchParams.get('range') ?? undefined;
	const range = parseCustomWindow(url, now) ?? buildWindow(isRangeKey(rangeParam) ? rangeParam : DEFAULT_RANGE, now);

	const zoneParam = url.searchParams.get('zone');
	// Must match a zone the token can actually see; anything else falls back to rollup.
	const zoneId = zoneParam && zones.some((z) => z.id === zoneParam) ? zoneParam : null;

	const detParam = url.searchParams.get('detection') ?? undefined;
	const detection: DetectionType = isDetectionType(detParam) ? detParam : 'all';

	const refreshRaw = Number.parseInt(url.searchParams.get('refresh') ?? '', 10);
	// Auto-refresh is forced off for an absolute window: it is fixed history, so reloading
	// re-fetches byte-identical data. Doing it here rather than in the view keeps the meta tag,
	// the cache key, the TTL clamp and qs() consistent for free.
	const refresh: RefreshInterval = isAbsolute(range) ? 0 : isRefreshInterval(refreshRaw) ? refreshRaw : DEFAULT_REFRESH;

	const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), 200) : 100;

	const narrow = parseNarrow(url);

	const sessionKeyParam = url.searchParams.get('sessionKey') ?? undefined;
	const sessionKey: SessionKey = isSessionKey(sessionKeyParam) ? sessionKeyParam : DEFAULT_SESSION_KEY;

	// Exact string match, not truthiness: `?compare=1` or `?compare=yes` must not silently work,
	// because the param is one day going to grow a second mode ("week") and a link written
	// against the loose reading would then mean something different.
	const compare = url.searchParams.get('compare') === 'prev';

	const endpointKeyParam = url.searchParams.get('endpointKey') ?? undefined;
	const endpointKey: EndpointKey = isEndpointKey(endpointKeyParam) ? endpointKeyParam : DEFAULT_ENDPOINT_KEY;

	return {
		range,
		zoneId,
		detection,
		refresh,
		limit,
		narrow,
		sessionKey,
		endpointKey,
		compare,
		// `refresh` is part of the key because it is rendered into the page as a meta tag.
		//
		// `narrow` is here too, and that is a deliberate reversal of the previous invariant that
		// no filter param was ever read server-side. Drill-down narrowing has to be applied
		// before the row slice, which means it changes the rendered HTML, which means it must
		// key the cache. Fragmentation stays bounded: `piiVals` and `unsafeVals` are catalog
		// enums, and the free-text keys are length-capped in validateNarrowValue(). The purely
		// client-side `f.*` params are still never parsed here and still never fragment it.
		cacheKey:
			`range=${range.key}${isAbsolute(range) ? `&start=${range.start}&end=${range.end}` : ''}` +
			`&zone=${zoneId ?? 'all'}&detection=${detection}&refresh=${refresh}&limit=${limit}&sessionKey=${sessionKey}&endpointKey=${endpointKey}&compare=${compare ? 'prev' : 'off'}${narrowCacheKey(narrow)}`,
	};
}

/**
 * Server-side cache TTL in seconds. When auto-refresh is on, never cache longer than its
 * cadence — otherwise a 30s refresh would re-serve the same HTML and appear frozen. With
 * refresh off (0) the range default applies; clamping to 0 would disable caching entirely.
 */
export function cacheTtl(win: TimeWindow, refresh: number = DEFAULT_REFRESH): number {
	// An absolute window is settled history: the answer cannot change, so cache it far longer
	// than a trailing window. `refresh` is already 0 for these by construction in parseParams.
	if (isAbsolute(win)) return 300;
	const base = win.key === '30m' ? 30 : 60;
	return refresh > 0 ? Math.min(base, refresh) : base;
}

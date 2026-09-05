import type { RawEvent, ZoneResult } from '../cf/queries';
import {
	categorySeverity,
	INJECTION_ATTACK_THRESHOLD,
	INJECTION_BUCKETS,
	INJECTION_UNSCORED,
	injectionBucket,
	piiLabel,
	unsafeTopicLabel,
} from './catalog';
import { countryFlag, countryName } from './geo';
import { buildMitigations, type Mitigation, type SignalStat } from './mitigations';
import {
	BUCKET_STEPS,
	DEFAULT_ENDPOINT_KEY,
	DEFAULT_SESSION_KEY,
	type DetectionType,
	type EndpointKey,
	type EventNarrow,
	type SessionKey,
	type TimeWindow,
} from './params';

export interface CountItem {
	key: string;
	label: string;
	count: number;
	tone?: string;
	/** Drill-down into the pre-filtered events view. Set by the view layer, not by buildDashboard. */
	href?: string;
}

/**
 * KPI ids that count detections, as opposed to volume/context tiles (`llm`, `ips`, `tokens`).
 *
 * Exported because the landing page sums exactly these for its "N detections in this window"
 * card, and hardcoding the list there meant a fifth signal would be silently left out. A test
 * asserts every id buildDashboard() emits is either in here or in the known non-detection set,
 * so adding a signal without updating this fails the suite instead of under-reporting.
 */
export const DETECTION_KPI_IDS = ['injection', 'pii', 'unsafe', 'custom'] as const;

/**
 * KPI ids the landing page shows: volume plus the detection signals, and nothing else.
 *
 * `ips` and `tokens` are context — useful when you are already investigating, not part of "is
 * anything wrong right now" — so they render on /analytics instead. Splitting by id here rather
 * than by position keeps both pages correct when a tile is conditional on schema capabilities
 * (`custom` and `tokens` both are), which slicing the array by index would not.
 */
export const HEADLINE_KPI_IDS = ['llm', ...DETECTION_KPI_IDS] as const;

/** The remainder — rendered on /analytics as a context row above the breakdowns. */
export const CONTEXT_KPI_IDS = ['ips', 'tokens'] as const;

export interface Kpi {
	id: string;
	label: string;
	value: number;
	prev?: number;
	hint?: string;
	tone: 'neutral' | 'warn' | 'danger';
	/** Drill-down into the pre-filtered events view; unset for tiles with no matching column (llm, ips). */
	href?: string;
}

/** One row of the "Targeted endpoints" breakdown — host+path split by detection type. */
export interface EndpointBreakdownRow {
	key: string;
	host: string;
	path: string;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	total: number;
}

/** One row of the "Source countries" breakdown — flagged requests grouped by client country. */
export interface CountryRow {
	code: string; // ISO alpha-2, as fetched
	name: string; // countryName(code)
	flag: string; // countryFlag(code)
	requests: number; // weighted total flagged requests from this country
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	distinctIps: number; // unique clientIP values seen from this country
	maxSeverity: Severity; // worst severityOf(e) across its events
}

export interface ZoneRollupRow {
	zoneId: string;
	zoneName: string;
	llmRequests: number;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	error: string | null;
}

/**
 * One row of the "Attacker sessions" table — flagged requests grouped by a session key
 * (source IP, JA4 TLS fingerprint, or ASN — see SessionKey). Whichever field is the active
 * group key is exact by construction (it built the Map); the other fields are "first seen"
 * context for that group, same as `country`/`asn` already were under IP grouping.
 */
export interface AttackerSessionRow {
	ip: string | null;
	country: string | null;
	asn: string | null;
	/** TLS client fingerprint. The group key when sessionKey === 'ja4', context otherwise. */
	ja4: string | null;
	firstSeen: string;
	lastSeen: string;
	requests: number;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
	blocked: number;
	distinctTargets: number;
	/**
	 * Distinct source IPs seen under this group. Trivially 1 when grouped by IP, but the whole
	 * point when grouped by JA4: a fingerprint reused across several rotated IPs collapses to
	 * one row with distinctIps > 1 — the exact signal per-IP grouping cannot show.
	 */
	distinctIps: number;
	maxSeverity: Severity;
}

export interface Dashboard {
	window: TimeWindow;
	kpis: Kpi[];
	trafficSeries: { ts: string; count: number }[];
	/**
	 * The previous period's traffic, shifted onto `trafficSeries`'s buckets and aligned to it
	 * index by index — same length, same order, zero-filled. Always built; the view decides
	 * whether to render it from `params.compare`, so turning the overlay on costs no fetch.
	 */
	trafficSeriesPrev: { ts: string; count: number }[];
	detectionSeries: { ts: string; injection: number; pii: number; unsafe: number; custom: number }[];
	topicBreakdown: CountItem[];
	piiBreakdown: CountItem[];
	customBreakdown: CountItem[];
	injectionHistogram: CountItem[];
	/**
	 * Per-score counts behind injectionHistogram, for the chart's drill-down: click the 1–19 bar
	 * and the same canvas re-renders as one bar per score in that range.
	 *
	 * Sparse and sorted — only scores that actually occurred appear, so a window with 40 distinct
	 * scores ships 40 entries, not 99 mostly-zero ones. The client fills the gaps, because only it
	 * knows which range is being drilled into. Scores are 1–99; the 100 sentinel ("not scored") is
	 * excluded, since it is a single value with nothing to break down and is not a low-risk score.
	 */
	injectionScores: { score: number; count: number }[];
	topCountries: CountItem[];
	topAsns: CountItem[];
	topIps: CountItem[];
	topTargets: CountItem[];
	endpointBreakdown: EndpointBreakdownRow[];
	countryBreakdown: CountryRow[];
	/** Ranked WAF rule recommendations, driven by what actually fired in the window. */
	mitigations: Mitigation[];
	/**
	 * Combined coverage of the `mitigations` rows — "if I enable these N rules, how much of what
	 * got through stops?" Grouped by the SET of listed signals each unstopped event carries (a
	 * bitmask over `mitigations`' own order, bit i = row i) rather than summed per row, because one
	 * request can carry two signals (PII and an unsafe topic) and appear in two rows; summing rows
	 * would double-count it and report coverage above 100%. See buildDashboard for how this is
	 * built. `total` is the weighted count of every distinct request a listed rule could stop.
	 */
	mitigationCoverage: { combos: [number, number][]; total: number };
	/**
	 * Row-sampling disclosure for Feature B. `rows` / `sampledRows` count allEvents (the row
	 * dataset), `maxInterval` is the largest sampleInterval observed. Consumed only by /analytics
	 * and /events — the KPI tiles, zone rollup and detection chart are built from the *aggregate*
	 * GraphQL dataset, which is not row-sampled, so this disclosure does not belong on them.
	 */
	sampling: { rows: number; sampledRows: number; maxInterval: number };
	zoneRollup: ZoneRollupRow[];
	attackerSessions: AttackerSessionRow[];
	/** The grouping actually used to build attackerSessions — echoes opts.sessionKey (default
	 * 'ip') so the view can render the right column headers even if a caller downgraded the
	 * request (e.g. JA4 requested on a schema that doesn't resolve it). */
	sessionKey: SessionKey;
	events: RawEvent[];
	zonesWithErrors: { zoneName: string; error: string }[];
	/**
	 * Set when at least one zone could not group its series at the requested granularity and
	 * fell back to a coarser dimension (see resolveBucket() in cf/queries.ts). Null in every
	 * observed schema. It exists because the old behaviour — silently substituting hourly —
	 * made a missing dimension look like flat traffic, which is indistinguishable from a quiet
	 * window; the view states it instead.
	 */
	bucketFallback: { requested: string; used: string; zones: string[] } | null;
	totalEvents: number;
	/** True if any per-zone row query hit the row cap, so counts are a floor. */
	truncated: boolean;
}

export function isInjection(e: RawEvent): boolean {
	return e.injectionScore !== null && e.injectionScore < INJECTION_ATTACK_THRESHOLD;
}

export function isPii(e: RawEvent): boolean {
	return e.piiCategories.length > 0;
}

export function isUnsafe(e: RawEvent): boolean {
	return e.unsafeTopicCategories.length > 0;
}

/**
 * True when a request matched at least one custom topic. Checked two ways because either
 * source of evidence might be the only one a given schema exposes: `customTopics` (the object
 * array) is the direct, human-readable evidence, while `customTopicScoreMin` (the scalar) is
 * the one the aggregate GraphQL filter actually uses (the object array has no filter operators
 * at all, per docs/graphql-fields.md). A row-level check must accept either.
 */
export function isCustomTopic(e: RawEvent): boolean {
	return e.customTopics.length > 0 || (e.customTopicScoreMin !== null && e.customTopicScoreMin < 100);
}

export function matchesDetection(e: RawEvent, type: DetectionType): boolean {
	switch (type) {
		case 'injection':
			return isInjection(e);
		case 'pii':
			return isPii(e);
		case 'unsafe':
			return isUnsafe(e);
		case 'custom':
			return isCustomTopic(e);
		default:
			return true;
	}
}

/**
 * True when the event satisfies every active narrowing key. Compared against the same *display
 * labels* the events table renders into its `data-*` attributes, because a drill-down link
 * carries one value that has to satisfy both this check and the browser's `f.*` picker — see
 * eventsHref() in views/links.ts.
 *
 * Keys AND together, mirroring the client-side column filters. A multi-value column matches if
 * ANY of the event's values equals the narrowing value, again mirroring rowPassesFilters().
 */
export function matchesNarrow(e: RawEvent, narrow: EventNarrow): boolean {
	// One helper for both column kinds: `has` returns every value the event carries for the key,
	// so a scalar column is just a one-element list. Written this way so "OR within a key" is
	// expressed once and cannot drift between the multi-value and scalar columns.
	const anyOf = (want: string[] | undefined, has: (string | null)[]): boolean =>
		want === undefined || has.some((v) => v !== null && want.includes(v));

	if (!anyOf(narrow.piiVals, e.piiCategories.map(piiLabel))) return false;
	if (!anyOf(narrow.unsafeVals, e.unsafeTopicCategories.map(unsafeTopicLabel))) return false;
	if (!anyOf(narrow.customVals, e.customTopics.map((t) => t.topicLabel))) return false;
	if (!anyOf(narrow.ip, [e.clientIP])) return false;
	if (!anyOf(narrow.target, [`${e.host ?? ''}${e.path ?? ''}`])) return false;
	if (!anyOf(narrow.host, [e.host])) return false;
	if (!anyOf(narrow.path, [e.path])) return false;
	if (!anyOf(narrow.country, [e.country])) return false;
	if (!anyOf(narrow.ja4, [e.ja4])) return false;
	// isTerminated(e) is the single source of truth for "did a rule already stop this" — mapped
	// to the same 'true'/'false' string vocabulary validateNarrowValue() accepts, so this key
	// reuses anyOf() like every other one instead of a separate boolean branch.
	if (!anyOf(narrow.mitigated, [isTerminated(e) ? 'true' : 'false'])) return false;
	return true;
}

/** True when any narrowing key is set — drives the events page's "narrowed" affordances. */
export function hasNarrow(narrow: EventNarrow): boolean {
	return Object.values(narrow).some((v) => v !== undefined && v.length > 0);
}

/**
 * Row datasets are adaptively sampled: each returned row stands for `sampleInterval`
 * real requests. Summing rows directly under-counts, so weight by the interval.
 */
function weight(e: RawEvent): number {
	return e.sampleInterval > 0 ? e.sampleInterval : 1;
}

function tally(events: RawEvent[], keyFn: (e: RawEvent) => string[] | string | null): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of events) {
		const raw = keyFn(e);
		if (raw === null) continue;
		const keys = Array.isArray(raw) ? raw : [raw];
		for (const k of keys) {
			if (!k) continue;
			out.set(k, (out.get(k) ?? 0) + weight(e));
		}
	}
	return out;
}

function topN(counts: Map<string, number>, n: number, label: (k: string) => string = (k) => k): CountItem[] {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([key, count]) => ({ key, label: label(key), count }));
}

/**
 * Truncate an ISO timestamp to the series bucket so events line up with traffic.
 * Both sides must go through this: GraphQL returns "2026-08-10T03:00:00Z" while
 * Date#toISOString produces "2026-08-10T03:00:00.000Z", and the two never merge
 * if compared as raw strings. Exported for tests — this exact bug (raw-string
 * comparison instead of going through bucketTs) has bitten twice already.
 */
/**
 * Every bucket timestamp in the window, whether or not anything happened in it.
 *
 * The aggregate API returns only buckets that have data, so a quiet window came back as a handful
 * of points — a 24-hour range whose traffic all landed in one hour rendered as a *single* dot,
 * which reads as "no data" rather than "one busy hour". Charting against this grid instead means
 * a 24h window always draws 24 hourly points, and a gap is visibly a gap.
 *
 * Bounded by the same `limit: 1000` the series aliases carry, so a pathological window cannot
 * spin here: the worst legal case is a 30-day range at hourly granularity (720 points), and the
 * cap only bites if bucketFor() and the query builder ever disagree.
 */
export function bucketGrid(win: TimeWindow): string[] {
	const step = BUCKET_STEPS.find((b) => b.dimension === win.bucket)?.stepMinutes ?? 60;
	const stepMs = step * 60_000;
	const end = Date.parse(win.end);
	// A 'date' bucket truncates to YYYY-MM-DD, which Date.parse reads as midnight UTC — exactly
	// the instant we want to step from, but only if we hand it the full ISO form.
	const first = bucketTs(win.start, win.bucket);
	let cursor = Date.parse(first.length === 10 ? `${first}T00:00:00Z` : first);
	const out: string[] = [];
	while (cursor <= end && out.length < 1000) {
		out.push(bucketTs(new Date(cursor).toISOString(), win.bucket));
		cursor += stepMs;
	}
	return out;
}

export function bucketTs(iso: string, bucket: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	switch (bucket) {
		case 'date':
			return d.toISOString().slice(0, 10);
		case 'datetimeFiveMinutes':
			d.setUTCSeconds(0, 0);
			d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5);
			return d.toISOString();
		case 'datetimeFifteenMinutes':
			d.setUTCSeconds(0, 0);
			d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15);
			return d.toISOString();
		default:
			d.setUTCMinutes(0, 0, 0);
			return d.toISOString();
	}
}

export interface BuildOptions {
	/** Token count is a Logpush-only field; when absent the KPI is hidden, not shown as zero. */
	hasTokenCount?: boolean;
	/**
	 * Custom topics need the `..._lt` filter operator on the ScoresMin scalar, which is
	 * capability-gated (see detectionFilters() in cf/queries.ts) because it isn't empirically
	 * verified on every schema variant. When absent the KPI is hidden, not shown as a false zero
	 * — same pattern as hasTokenCount.
	 */
	hasCustomTopics?: boolean;
	/**
	 * Builds the drill-down URL for a detection KPI tile (injection/pii/unsafe/custom).
	 * Injected rather than imported directly: eventsHref lives in views/layout.tsx and needs the
	 * full DashboardParams (zone, range, refresh) that this domain function does not receive, and
	 * domain code should not depend on the views layer. Omitted means the tile renders unlinked.
	 */
	kpiHref?: (detection: DetectionType) => string;
	/**
	 * Server-side narrowing from a drill-down link, already validated by parseParams. Applied to
	 * the `events` list only — every breakdown keeps counting the full fetched set, so following
	 * a link never changes the numbers that produced it. Omitted means no narrowing.
	 */
	narrow?: EventNarrow;
	/**
	 * Grouping key for the "Attacker sessions" table. Defaults to 'ip' (the original behaviour)
	 * when omitted. The caller (index.tsx) is responsible for downgrading a 'ja4' request the
	 * schema cannot back — this function trusts whatever it is given and will happily group by
	 * a field that is always null, producing an empty table, if asked to.
	 */
	sessionKey?: SessionKey;
	/** How to group the endpoint breakdown. Defaults to host+path, the level a WAF rule uses. */
	endpointKey?: EndpointKey;
}

export function buildDashboard(
	results: ZoneResult[],
	win: TimeWindow,
	detection: DetectionType,
	opts: BuildOptions = {},
): Dashboard {
	// Dedupe across zones by ray ID, mirroring the per-zone dedupe in queries.ts — the same
	// request should never be double-counted just because it surfaced in two result sets.
	const allEvents = (() => {
		const seen = new Map<string, RawEvent>();
		for (const r of results) {
			for (const e of r.events) {
				const key = e.rayName ?? `${e.datetime}|${e.clientIP}|${e.path}`;
				if (!seen.has(key)) seen.set(key, e);
			}
		}
		return [...seen.values()];
	})();
	// Resolved up here rather than beside sessionKey further down, because endpointBreakdown is
	// built before that point and would otherwise read an undeclared binding.
	const endpointKey: EndpointKey = opts.endpointKey ?? DEFAULT_ENDPOINT_KEY;

	// Narrowing is applied HERE, to `events` only, and deliberately not to `allEvents`: the
	// overview breakdowns downstream must keep counting every fetched row, otherwise drilling into
	// a category would rewrite the very numbers that produced the link. The events page then
	// slices `params.limit` out of an already-relevant list instead of the newest 200 overall.
	const events = allEvents
		.filter((e) => matchesDetection(e, detection) && matchesNarrow(e, opts.narrow ?? {}))
		.sort((a, b) => b.datetime.localeCompare(a.datetime));

	const llmRequests = results.reduce((s, r) => s + r.llmRequests, 0);
	const llmRequestsPrev = results.reduce((s, r) => s + r.llmRequestsPrev, 0);

	// Headline counts come from the aggregate dataset (exact); only the breakdowns below
	// are derived from the sampled, row-capped event list.
	const injectionCount = results.reduce((s, r) => s + r.detections.injection, 0);
	const piiCount = results.reduce((s, r) => s + r.detections.pii, 0);
	const unsafeCount = results.reduce((s, r) => s + r.detections.unsafe, 0);
	// Defensive `?? 0`: detections.custom is a newly-added field, so a warm cache entry written
	// by the previous deploy (before RESULT_VERSION was bumped) could in principle lack it.
	const customCount = results.reduce((s, r) => s + (r.detections.custom ?? 0), 0);

	// Previous-window counterparts, for the KPI deltas. Defensive `?? 0` throughout: detectionsPrev
	// is a new field on ZoneResult, and RESULT_VERSION exists precisely so a stale warm cache entry
	// from before this deploy doesn't crash on a bare property access.
	const injectionPrev = results.reduce((s, r) => s + (r.detectionsPrev?.injection ?? 0), 0);
	const piiPrev = results.reduce((s, r) => s + (r.detectionsPrev?.pii ?? 0), 0);
	const unsafePrev = results.reduce((s, r) => s + (r.detectionsPrev?.unsafe ?? 0), 0);
	const customPrev = results.reduce((s, r) => s + (r.detectionsPrev?.custom ?? 0), 0);

	const tokenTotal = allEvents.reduce((s, e) => s + (e.tokenCount ?? 0) * weight(e), 0);
	const uniqueIps = new Set(allEvents.map((e) => e.clientIP).filter(Boolean)).size;

	const kpis: Kpi[] = [
		{ id: 'llm', label: 'LLM requests', value: llmRequests, prev: llmRequestsPrev, tone: 'neutral', hint: `Requests matching the cf-llm endpoint label` },
		{
			id: 'injection',
			label: 'Prompt injection',
			value: injectionCount,
			prev: injectionPrev,
			tone: injectionCount > 0 ? 'danger' : 'neutral',
			hint: `Injection score below ${INJECTION_ATTACK_THRESHOLD} (lower score = more likely an attack)`,
			href: opts.kpiHref?.('injection'),
		},
		{
			id: 'pii',
			label: 'PII in prompt',
			value: piiCount,
			prev: piiPrev,
			tone: piiCount > 0 ? 'warn' : 'neutral',
			hint: 'Prompts containing personally identifiable information',
			href: opts.kpiHref?.('pii'),
		},
		{
			id: 'unsafe',
			label: 'Unsafe topic',
			value: unsafeCount,
			prev: unsafePrev,
			tone: unsafeCount > 0 ? 'warn' : 'neutral',
			hint: 'Prompts matching an unsafe topic category (S1–S14)',
			href: opts.kpiHref?.('unsafe'),
		},
	];

	if (opts.hasCustomTopics) {
		kpis.push({
			id: 'custom',
			label: 'Custom topic',
			value: customCount,
			prev: customPrev,
			tone: customCount > 0 ? 'warn' : 'neutral',
			hint: 'Prompts matching one of your custom topics (1–99, lower = stronger match)',
			href: opts.kpiHref?.('custom'),
		});
	}

	kpis.push({ id: 'ips', label: 'Distinct source IPs', value: uniqueIps, tone: 'neutral', hint: 'Unique client IPs across flagged requests' });

	if (opts.hasTokenCount) {
		kpis.push({
			id: 'tokens',
			label: 'Tokens in flagged prompts',
			value: tokenTotal,
			tone: 'neutral',
			hint: 'Token count summed over flagged requests only',
		});
	}

	const trafficSeries = (() => {
		const merged = new Map<string, number>();
		for (const r of results) {
			for (const p of r.series) {
				if (!p.ts) continue;
				const ts = bucketTs(p.ts, win.bucket);
				merged.set(ts, (merged.get(ts) ?? 0) + p.count);
			}
		}
		// Grid-driven, not key-driven: an hour with no traffic must render as a zero, not vanish.
		return bucketGrid(win).map((ts) => ({ ts, count: merged.get(ts) ?? 0 }));
	})();

	/**
	 * The previous window's traffic, shifted forward by one window span so it lines up with
	 * `trafficSeries` on a shared x-axis.
	 *
	 * The shift is the whole trick, and it is why this is not simply a second series: the previous
	 * window's timestamps are a whole span earlier, so plotting them raw would draw the ghost line
	 * off to the left of the chart instead of underneath the line it is meant to be compared with.
	 * Shifting by `end - start` maps prev bucket N onto current bucket N.
	 *
	 * Emitted aligned to `trafficSeries` — one entry per current bucket, in the same order, zero
	 * where the previous window had no traffic in that slot. That means the chart can index the
	 * two arrays together and cannot silently pair bucket 3 of one with bucket 5 of the other.
	 *
	 * Both windows are the same length by construction (`prevStart = start - span`), so this is a
	 * translation, not a resample. A DST boundary does not disturb it either: every instant here
	 * is UTC and the arithmetic is on epoch milliseconds.
	 */
	const trafficSeriesPrev = (() => {
		const span = Date.parse(win.end) - Date.parse(win.start);
		const merged = new Map<string, number>();
		for (const r of results) {
			for (const p of r.seriesPrev ?? []) {
				if (!p.ts) continue;
				const shifted = Date.parse(p.ts) + span;
				if (!Number.isFinite(shifted)) continue;
				const ts = bucketTs(new Date(shifted).toISOString(), win.bucket);
				merged.set(ts, (merged.get(ts) ?? 0) + p.count);
			}
		}
		return trafficSeries.map((point) => ({ ts: point.ts, count: merged.get(point.ts) ?? 0 }));
	})();

	// Built from the same aggregate dataset as the KPI tiles (exact, uncapped) rather than
	// from the row list, so the chart and the tiles never disagree when rows hit the cap.
	// Availability is per signal: a zone whose schema lacks a given detection filter falls
	// back to the row-derived count for THAT signal only, instead of showing a false zero.
	// A zone that errored contributes to neither source and is excluded from the vote.
	const healthyResults = results.filter((r) => !r.error);
	const seriesAvailable = {
		injection: healthyResults.length > 0 && healthyResults.every((r) => r.detectionSeriesAvailable.injection),
		pii: healthyResults.length > 0 && healthyResults.every((r) => r.detectionSeriesAvailable.pii),
		unsafe: healthyResults.length > 0 && healthyResults.every((r) => r.detectionSeriesAvailable.unsafe),
		custom: healthyResults.length > 0 && healthyResults.every((r) => r.detectionSeriesAvailable.custom),
	};

	const aggSeries = new Map<string, { injection: number; pii: number; unsafe: number; custom: number }>();
	for (const p of trafficSeries) aggSeries.set(p.ts, { injection: 0, pii: 0, unsafe: 0, custom: 0 });
	for (const r of results) {
		for (const p of r.detectionSeries) {
			if (!p.ts) continue;
			const ts = bucketTs(p.ts, win.bucket);
			const slot = aggSeries.get(ts) ?? { injection: 0, pii: 0, unsafe: 0, custom: 0 };
			slot.injection += p.injection;
			slot.pii += p.pii;
			slot.unsafe += p.unsafe;
			slot.custom += p.custom;
			aggSeries.set(ts, slot);
		}
	}

	// Fallback source, computed unconditionally but only consulted per-signal when the
	// aggregate is unavailable for that signal.
	const rowSeries = new Map<string, { injection: number; pii: number; unsafe: number; custom: number }>();
	for (const p of trafficSeries) rowSeries.set(p.ts, { injection: 0, pii: 0, unsafe: 0, custom: 0 });
	for (const e of allEvents) {
		const ts = bucketTs(e.datetime, win.bucket);
		const slot = rowSeries.get(ts) ?? { injection: 0, pii: 0, unsafe: 0, custom: 0 };
		const w = weight(e);
		if (isInjection(e)) slot.injection += w;
		if (isPii(e)) slot.pii += w;
		if (isUnsafe(e)) slot.unsafe += w;
		if (isCustomTopic(e)) slot.custom += w;
		rowSeries.set(ts, slot);
	}

	const detectionSeries = (() => {
		// Same grid as trafficSeries so the two charts share an x-axis, and an empty bucket is a
		// visible zero rather than a missing point that silently shortens the line.
		return bucketGrid(win).map((ts) => ({
			ts,
			injection: (seriesAvailable.injection ? aggSeries.get(ts)?.injection : rowSeries.get(ts)?.injection) ?? 0,
			pii: (seriesAvailable.pii ? aggSeries.get(ts)?.pii : rowSeries.get(ts)?.pii) ?? 0,
			unsafe: (seriesAvailable.unsafe ? aggSeries.get(ts)?.unsafe : rowSeries.get(ts)?.unsafe) ?? 0,
			custom: (seriesAvailable.custom ? aggSeries.get(ts)?.custom : rowSeries.get(ts)?.custom) ?? 0,
		}));
	})();

	const topicBreakdown = topN(tally(allEvents, (e) => e.unsafeTopicCategories), 14, unsafeTopicLabel);
	const piiBreakdown = topN(tally(allEvents, (e) => e.piiCategories), 15, piiLabel);
	const customBreakdown = topN(tally(allEvents, (e) => e.customTopics.map((t) => t.topicLabel)), 15);

	// A zone with no series at all (seriesBucket null — nothing was queried) is not a fallback;
	// only an actual substitution counts, so a zone that failed outright cannot raise the notice.
	const bucketFallback = (() => {
		const off = results.filter((r) => r.seriesBucket && r.seriesBucket !== win.bucket);
		if (!off.length) return null;
		return { requested: win.bucket, used: off[0].seriesBucket!, zones: off.map((r) => r.zone.name) };
	})();

	const injectionHistogram = (() => {
		const counts = new Map<string, number>(INJECTION_BUCKETS.map((b) => [b.label, 0]));
		for (const e of allEvents) {
			if (e.injectionScore === null) continue;
			const b = injectionBucket(e.injectionScore);
			counts.set(b.label, (counts.get(b.label) ?? 0) + weight(e));
		}
		return INJECTION_BUCKETS.map((b) => ({
			key: b.label,
			label: b.label,
			count: counts.get(b.label) ?? 0,
			tone: b.tone,
		}));
	})();

	// Same sampling weight as the histogram above, so a drilled bucket's bars sum to the bucket
	// bar the user clicked. Counting rows instead would make the two disagree on sampled traffic.
	const injectionScores = (() => {
		const counts = new Map<number, number>();
		for (const e of allEvents) {
			if (e.injectionScore === null || e.injectionScore === INJECTION_UNSCORED) continue;
			counts.set(e.injectionScore, (counts.get(e.injectionScore) ?? 0) + weight(e));
		}
		return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([score, count]) => ({ score, count }));
	})();

	// Same host+path key as topTargets, but split by detection type so it's clear which
	// endpoint attracts which kind of abuse rather than just a raw hit count. The grouping key is
	// a request parameter: host+path is the level a WAF rule is written at, but "which host is
	// taking the abuse" and "which route is weak across every host" are questions the combined
	// key cannot answer, and both are one GROUP BY away from data already in memory.
	const endpointBreakdown: EndpointBreakdownRow[] = (() => {
		const map = new Map<string, { host: string; path: string; injection: number; pii: number; unsafe: number; custom: number }>();
		for (const e of allEvents) {
			// Grouping by path alone is the one case a missing host does not disqualify a row: the
			// route is the whole key there, so dropping it would silently undercount.
			if (!e.host && endpointKey !== 'path') continue;
			const host = e.host ?? '';
			const path = e.path ?? '';
			const key = endpointKey === 'host' ? host : endpointKey === 'path' ? path : `${host}${path}`;
			if (!key) continue;
			// The columns the active grouping does not key on are blanked rather than filled from
			// whichever event happened to create the bucket — showing one arbitrary member's path
			// beside a host's aggregate total would read as though the total belonged to that path.
			const slot = map.get(key) ?? {
				host: endpointKey === 'path' ? '' : host,
				path: endpointKey === 'host' ? '' : path,
				injection: 0,
				pii: 0,
				unsafe: 0,
				custom: 0,
			};
			const w = weight(e);
			if (isInjection(e)) slot.injection += w;
			if (isPii(e)) slot.pii += w;
			if (isUnsafe(e)) slot.unsafe += w;
			if (isCustomTopic(e)) slot.custom += w;
			map.set(key, slot);
		}
		return [...map.entries()]
			.map(([key, v]) => ({ key, ...v, total: v.injection + v.pii + v.unsafe + v.custom }))
			.filter((r) => r.total > 0)
			.sort((a, b) => b.total - a.total)
			.slice(0, 15);
	})();

	// Same allEvents source as endpointBreakdown and attackerSessions: this view must show the
	// whole picture regardless of the top-bar detection filter, and must not be narrowed by a
	// drill-down — otherwise following a country's own link would rewrite the row that produced it.
	const countryBreakdown: CountryRow[] = (() => {
		const map = new Map<
			string,
			{ code: string; injection: number; pii: number; unsafe: number; custom: number; ips: Set<string>; maxSeverity: Severity }
		>();
		for (const e of allEvents) {
			if (!e.country) continue;
			const slot = map.get(e.country) ?? {
				code: e.country,
				injection: 0,
				pii: 0,
				unsafe: 0,
				custom: 0,
				ips: new Set<string>(),
				maxSeverity: 'low' as Severity,
			};
			const w = weight(e);
			if (isInjection(e)) slot.injection += w;
			if (isPii(e)) slot.pii += w;
			if (isUnsafe(e)) slot.unsafe += w;
			if (isCustomTopic(e)) slot.custom += w;
			if (e.clientIP) slot.ips.add(e.clientIP);
			const sev = severityOf(e);
			if (SEVERITY_RANK[sev] > SEVERITY_RANK[slot.maxSeverity]) slot.maxSeverity = sev;
			map.set(e.country, slot);
		}
		return [...map.values()]
			.map(
				(v): CountryRow => ({
					code: v.code,
					name: countryName(v.code),
					flag: countryFlag(v.code),
					requests: v.injection + v.pii + v.unsafe + v.custom,
					injection: v.injection,
					pii: v.pii,
					unsafe: v.unsafe,
					custom: v.custom,
					distinctIps: v.ips.size,
					maxSeverity: v.maxSeverity,
				}),
			)
			.filter((r) => r.requests > 0)
			.sort((a, b) => b.requests - a.requests)
			.slice(0, 15);
	})();

	const zoneRollup: ZoneRollupRow[] = results.map((r) => ({
		zoneId: r.zone.id,
		zoneName: r.zone.name,
		llmRequests: r.llmRequests,
		injection: r.detections.injection,
		pii: r.detections.pii,
		unsafe: r.detections.unsafe,
		custom: r.detections.custom ?? 0,
		error: r.error,
	}));

	// Attacker sessions: group flagged requests by a session key (source IP by default) so a
	// coordinated campaign reads as one row instead of N. Built from allEvents (not the
	// detection-filtered `events`) because this view should show the whole picture regardless
	// of the top-bar detection filter.
	//
	// The grouping key is pluggable (SessionKey: 'ip' | 'ja4' | 'asn') because per-IP grouping
	// breaks the moment an attacker rotates addresses — the JA4 TLS client fingerprint survives
	// that. Whichever field keyOf() reads for the active grouping is exact on the resulting row
	// (it built the Map), because the first event to create a slot necessarily has that same
	// field value; the other contextual fields (ip/country/asn/ja4 not driving the grouping)
	// are simply the first-seen value for the group, same as country/asn always were.
	const sessionKey: SessionKey = opts.sessionKey ?? DEFAULT_SESSION_KEY;
	const attackerSessions: AttackerSessionRow[] = (() => {
		interface SessionAcc {
			ip: string | null;
			country: string | null;
			asn: string | null;
			ja4: string | null;
			firstSeen: string;
			lastSeen: string;
			requests: number;
			injection: number;
			pii: number;
			unsafe: number;
			custom: number;
			blocked: number;
			targets: Set<string>;
			ips: Set<string>;
			maxSeverity: Severity;
		}

		const keyOf = (e: RawEvent): string | null => {
			switch (sessionKey) {
				case 'ja4':
					return e.ja4;
				case 'asn':
					return e.asnDescription;
				default:
					return e.clientIP;
			}
		};

		const map = new Map<string, SessionAcc>();
		for (const e of allEvents) {
			const key = keyOf(e);
			if (!key) continue;
			const w = weight(e);
			const slot = map.get(key) ?? {
				ip: null,
				country: null,
				asn: null,
				ja4: null,
				firstSeen: e.datetime,
				lastSeen: e.datetime,
				requests: 0,
				injection: 0,
				pii: 0,
				unsafe: 0,
				custom: 0,
				blocked: 0,
				targets: new Set<string>(),
				ips: new Set<string>(),
				maxSeverity: 'low' as Severity,
			};
			slot.ip ??= e.clientIP;
			slot.country ??= e.country;
			slot.asn ??= e.asnDescription;
			slot.ja4 ??= e.ja4;
			if (e.clientIP) slot.ips.add(e.clientIP);
			// ISO-8601 UTC timestamps sort lexicographically, so plain string comparison finds min/max.
			if (e.datetime < slot.firstSeen) slot.firstSeen = e.datetime;
			if (e.datetime > slot.lastSeen) slot.lastSeen = e.datetime;
			slot.requests += w;
			if (isInjection(e)) slot.injection += w;
			if (isPii(e)) slot.pii += w;
			if (isUnsafe(e)) slot.unsafe += w;
			if (isCustomTopic(e)) slot.custom += w;
			if (isTerminated(e)) slot.blocked += w;
			if (e.host) slot.targets.add(`${e.host}${e.path ?? ''}`);
			const sev = severityOf(e);
			if (SEVERITY_RANK[sev] > SEVERITY_RANK[slot.maxSeverity]) slot.maxSeverity = sev;
			map.set(key, slot);
		}
		return [...map.values()]
			.map((s): AttackerSessionRow => ({
				ip: s.ip,
				country: s.country,
				asn: s.asn,
				ja4: s.ja4,
				firstSeen: s.firstSeen,
				lastSeen: s.lastSeen,
				requests: s.requests,
				injection: s.injection,
				pii: s.pii,
				unsafe: s.unsafe,
				custom: s.custom,
				blocked: s.blocked,
				distinctTargets: s.targets.size,
				distinctIps: s.ips.size,
				maxSeverity: s.maxSeverity,
			}))
			.sort((a, b) => SEVERITY_RANK[b.maxSeverity] - SEVERITY_RANK[a.maxSeverity] || b.requests - a.requests)
			.slice(0, 15);
	})();

	// Per-signal detected-vs-already-blocked counts, the input to the mitigation recommendations.
	// Computed here rather than in mitigations.ts because this is the only scope that holds the
	// full event list; keeping the split that way also means mitigations.ts never has to import
	// from this file, which would be a cycle.
	const mitigations = (() => {
		const stats: SignalStat[] = [];
		const bump = (map: Map<string, SignalStat>, kind: SignalStat['kind'], code: string, w: number, blocked: boolean) => {
			const slot = map.get(code) ?? { kind, code, count: 0, blocked: 0 };
			slot.count += w;
			if (blocked) slot.blocked += w;
			map.set(code, slot);
		};

		const pii = new Map<string, SignalStat>();
		const unsafe = new Map<string, SignalStat>();
		const custom = new Map<string, SignalStat>();
		let injectionCount = 0;
		let injectionBlocked = 0;

		for (const e of allEvents) {
			const w = weight(e);
			const stopped = isTerminated(e);
			if (isInjection(e)) {
				injectionCount += w;
				if (stopped) injectionBlocked += w;
			}
			for (const c of e.piiCategories) bump(pii, 'pii', c, w, stopped);
			for (const c of e.unsafeTopicCategories) bump(unsafe, 'unsafe', c, w, stopped);
			for (const t of e.customTopics) bump(custom, 'custom', t.topicLabel, w, stopped);
		}

		if (injectionCount > 0) stats.push({ kind: 'injection', code: '', count: injectionCount, blocked: injectionBlocked });
		stats.push(...pii.values(), ...unsafe.values(), ...custom.values());
		return buildMitigations(stats);
	})();

	// Feature A: rule-coverage simulator. Built from allEvents (not the detection-filtered
	// `events`), same reasoning as every other breakdown above: this must describe the whole
	// window regardless of the top-bar detection filter or a drill-down narrow.
	//
	// An already-terminated event contributes nothing — a rule that already stopped it is not
	// "still getting through", so it cannot be part of what enabling more rules would newly catch.
	// For every other event, set bit i of a mask when it carries mitigations[i]'s signal (mask 0
	// means no listed rule would touch it, so it is skipped), weight it, and sum weights per mask.
	// Grouping by mask — not summing per mitigation row — is what makes overlap safe: a request
	// carrying two listed signals sets two bits and lands in ONE bucket, so selecting both rules
	// counts it once instead of twice. With mitigations capped at 8 rows there are at most
	// 2^8 - 1 = 255 distinct non-zero masks, so this payload is bounded and tiny no matter how many
	// events the window holds — that bound is the entire point of grouping by mask.
	const mitigationCoverage = (() => {
		const combos = new Map<number, number>();
		for (const e of allEvents) {
			if (isTerminated(e)) continue;
			let mask = 0;
			for (let i = 0; i < mitigations.length; i++) {
				const m = mitigations[i];
				let hit: boolean;
				switch (m.kind) {
					case 'injection':
						hit = isInjection(e);
						break;
					case 'pii':
						hit = e.piiCategories.includes(m.code);
						break;
					case 'unsafe':
						hit = e.unsafeTopicCategories.includes(m.code);
						break;
					case 'custom':
						hit = e.customTopics.some((t) => t.topicLabel === m.code);
						break;
				}
				if (hit) mask |= 1 << i;
			}
			if (mask === 0) continue;
			combos.set(mask, (combos.get(mask) ?? 0) + weight(e));
		}
		const pairs: [number, number][] = [...combos.entries()];
		const total = pairs.reduce((sum, [, w]) => sum + w, 0);
		return { combos: pairs, total };
	})();

	// Feature B: sampling confidence. `rows`/`sampledRows` count allEvents — the row dataset that
	// backs the breakdowns, histogram, tables and event list — not the aggregate dataset behind
	// the KPI tiles/zone rollup/detection chart, which is never row-sampled and gets no disclosure.
	// weight(e) > 1 is exactly "sampleInterval > 1" (weight() floors at 1), so this reuses the same
	// helper every count above already goes through instead of re-reading sampleInterval directly.
	const sampling = (() => {
		let sampledRows = 0;
		let maxInterval = 1;
		for (const e of allEvents) {
			const w = weight(e);
			if (w > 1) {
				sampledRows++;
				if (w > maxInterval) maxInterval = w;
			}
		}
		return { rows: allEvents.length, sampledRows, maxInterval };
	})();

	const truncated = results.some((r) => r.truncated);

	return {
		window: win,
		kpis,
		trafficSeries,
		trafficSeriesPrev,
		detectionSeries,
		topicBreakdown,
		piiBreakdown,
		customBreakdown,
		injectionHistogram,
		injectionScores,
		topCountries: topN(tally(allEvents, (e) => e.country), 10),
		topAsns: topN(tally(allEvents, (e) => e.asnDescription), 10),
		topIps: topN(tally(allEvents, (e) => e.clientIP), 10),
		topTargets: topN(tally(allEvents, (e) => (e.host ? `${e.host}${e.path ?? ''}` : null)), 10),
		endpointBreakdown,
		countryBreakdown,
		mitigations,
		mitigationCoverage,
		sampling,
		zoneRollup,
		attackerSessions,
		sessionKey,
		events,
		zonesWithErrors: results.filter((r) => r.error).map((r) => ({ zoneName: r.zone.name, error: r.error! })),
		bucketFallback,
		totalEvents: events.length,
		truncated,
	};
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Numeric rank for sorting — higher is worse. Kept in lockstep with the Severity union. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Severity is the MAXIMUM across every signal present on the event, not a single
 * hardcoded rule — each PII/unsafe-topic category already carries its own rating in
 * catalog.ts (categorySeverity), so this just takes the worst of: injection score,
 * every PII category hit, every unsafe-topic category hit, and the custom-topic
 * minimum score. An event with no signal at all is 'low', never unrated.
 *
 * Score semantics are INVERTED for both injection score and custom topic score:
 * 1-99 where LOWER = a STRONGER match, and 100 is the sentinel for "no match" (not a
 * safe score to report the underlying detector's confidence on) — so both are only
 * consulted when not equal to the unscored/no-match sentinel.
 *
 * WAF action is deliberately not a signal here: action describes how Cloudflare
 * responded to the request, not how dangerous the prompt was, and it already has its
 * own column.
 */
export function severityOf(e: RawEvent): Severity {
	let worst: Severity = 'low';
	const bump = (s: Severity) => {
		if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
	};

	if (e.injectionScore !== null && e.injectionScore !== INJECTION_UNSCORED) {
		if (e.injectionScore < 10) bump('critical');
		else if (e.injectionScore < 20) bump('high');
		else if (e.injectionScore < 40) bump('medium');
	}

	for (const c of e.piiCategories) bump(categorySeverity('pii', c));
	for (const c of e.unsafeTopicCategories) bump(categorySeverity('topic', c));

	if (e.customTopicScoreMin !== null && e.customTopicScoreMin !== 100) {
		if (e.customTopicScoreMin < 10) bump('critical');
		else if (e.customTopicScoreMin < 30) bump('high');
		else if (e.customTopicScoreMin < 60) bump('medium');
		else bump('low');
	}

	return worst;
}

/**
 * Terminating actions stop ruleset execution, so the AI Security Log Mode ruleset never
 * runs for these requests and no prompt is captured. Confirmed live: 0 of 48 blocked
 * requests had a Log Mode event.
 */
const TERMINATING_ACTIONS = new Set([
	'block',
	'challenge',
	'jschallenge',
	'managedchallenge',
	'connectionclose',
	'drop',
]);

export function isTerminated(e: RawEvent): boolean {
	return !!e.securityAction && TERMINATING_ACTIONS.has(e.securityAction.toLowerCase());
}

export function scoreLabel(score: number | null): string {
	if (score === null) return '—';
	if (score === INJECTION_UNSCORED) return 'not scored';
	return String(score);
}

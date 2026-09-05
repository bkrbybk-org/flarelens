import { graphqlSafe } from './client';
import type { DatasetCaps, SchemaCaps, WaitUntil } from './schema';
import type { AiSecEnv, Zone } from './types';
import { INJECTION_ATTACK_THRESHOLD, LLM_LABEL, PII_CATEGORIES, UNSAFE_TOPICS } from '../domain/catalog';
import { BUCKET_STEPS, isAbsolute, type TimeWindow } from '../domain/params';

/** Max zones queried concurrently — GraphQL is zone-scoped, so account-wide is a fan-out. */
const CONCURRENCY = 6;
/** Per-detection-type row cap. httpRequestsAdaptive tops out at 10000. */
const ROW_LIMIT = 2000;

/**
 * The AI Security Log Mode managed ruleset. Its rules carry payload logging, so their
 * firewall events hold the encrypted prompt. Documented as the ruleset "ending d385e336".
 *
 * The default only. `env.AI_LOG_MODE_RULESET_ID` overrides it, and setting that to the empty
 * string drops the filter entirely — see logModeRuleset() for what each choice costs.
 */
export const AI_LOG_MODE_RULESET_ID = 'b7cd52df92f74c848cec0c2ed385e336';

/**
 * Which ruleset id, if any, the payload query should filter on.
 *
 * If Cloudflare ever renumbers the Log Mode ruleset, the hardcoded default stops matching and
 * encrypted prompts vanish with no error anywhere — the failure mode that made this configurable.
 * Three cases:
 *
 *   unset          the constant above (today's behaviour, unchanged)
 *   32 hex chars   that id instead — a config edit, no redeploy of code
 *   empty string   no ruleset filter at all; the caller must then keep only rows that actually
 *                  carry payload metadata, because every other firewall event in the window
 *                  would otherwise attach its rule description to an unrelated request
 *
 * Anything else is ignored in favour of the default: the value is interpolated straight into a
 * GraphQL document, so it is validated by shape rather than trusted for being operator-set.
 */
export function logModeRuleset(env: AiSecEnv): string | null {
	const override = env.AI_LOG_MODE_RULESET_ID;
	if (override === undefined) return AI_LOG_MODE_RULESET_ID;
	if (override === '') return null;
	return /^[0-9a-f]{32}$/.test(override) ? override : AI_LOG_MODE_RULESET_ID;
}

export interface PayloadInfo {
	/** Rule descriptions that fired for this request, e.g. "Detects PII categories in the prompt". */
	rules: string[];
	/** Fields the rule matched on, e.g. cf.llm.prompt.pii_categories[*]. Useful without decrypting. */
	matchedVars: string[];
	/** Base64 HPKE blob; decryptable only in the browser with the operator's private key. */
	encrypted: string | null;
}

export interface RawEvent {
	zoneId: string;
	zoneName: string;
	datetime: string;
	rayName: string | null;
	clientIP: string | null;
	country: string | null;
	asnDescription: string | null;
	/** TLS client fingerprint (JA4). Stable across IP rotation, unlike clientIP. */
	ja4: string | null;
	host: string | null;
	path: string | null;
	method: string | null;
	status: number | null;
	securityAction: string | null;
	injectionScore: number | null;
	piiCategories: string[];
	unsafeTopicCategories: string[];
	customTopics: { topicLabel: string; score: number }[];
	/** Min score across customTopics. Same inverted semantics as injectionScore; 100 = no match. */
	customTopicScoreMin: number | null;
	tokenCount: number | null;
	sampleInterval: number;
	/** Payload-logging detail, when the Log Mode ruleset produced a matching firewall event. */
	payload: PayloadInfo | null;
	/**
	 * Bare UUID (webAssetsOperationId). Useful for correlating with API Shield, but mapping
	 * it to a readable endpoint needs a permission this token does not have, so it is
	 * surfaced as a raw ID only, never as a display label.
	 */
	operationId: string | null;
}

export interface SeriesPoint {
	ts: string;
	count: number;
}

export interface DetectionSeriesPoint {
	ts: string;
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
}

export interface DetectionCounts {
	injection: number;
	pii: number;
	unsafe: number;
	custom: number;
}

export interface ZoneResult {
	zone: Zone;
	llmRequests: number;
	llmRequestsPrev: number;
	/**
	 * Exact detection counts from the aggregate dataset — not derived from the sampled,
	 * row-capped event list, so headline numbers stay correct even when rows are truncated.
	 */
	detections: DetectionCounts;
	/** Same shape as `detections`, but for the prevStart/prevEnd window — powers the KPI deltas. */
	detectionsPrev: DetectionCounts;
	series: SeriesPoint[];
	/**
	 * The same traffic series over the *previous* window (prevStart..prevEnd), for the compare
	 * overlay. Fetched unconditionally rather than only when `?compare=prev` is set: it is one
	 * more aggregate alias in a document that already carries a dozen, and making it conditional
	 * would fork the ZoneResult shape — a cache entry written in compare mode would then be
	 * missing the field when read back outside it, or vice versa. One shape, always populated.
	 */
	seriesPrev: SeriesPoint[];
	/**
	 * Per-bucket detection counts from the aggregate dataset (same source as `detections`),
	 * grouped the same way `series` is. Exact and uncapped, unlike deriving the series from
	 * the row list. `detectionSeriesAvailable` says which of the three actually came from
	 * the aggregate query — a signal whose group filter the schema doesn't expose is absent
	 * here and the caller must fall back to the row-derived series for that signal only.
	 */
	detectionSeries: DetectionSeriesPoint[];
	detectionSeriesAvailable: { injection: boolean; pii: boolean; unsafe: boolean; custom: boolean };
	/**
	 * The dimension `series` and `detectionSeries` are actually grouped by. Equal to
	 * `win.bucket` in every observed schema; coarser when the requested dimension is missing,
	 * and null when no series was fetched at all. Compared against `win.bucket` by transform.ts
	 * so a reduced granularity is stated rather than looking like flat traffic.
	 */
	seriesBucket: string | null;
	events: RawEvent[];
	/** Non-null when this zone's data could not be fetched. */
	error: string | null;
	/** True when any per-detection row query returned a full page, so breakdowns are partial. */
	truncated: boolean;
}

const EMPTY_DETECTIONS: DetectionCounts = { injection: 0, pii: 0, unsafe: 0, custom: 0 };
const EMPTY_SERIES_AVAILABLE = { injection: false, pii: false, unsafe: false, custom: false };

function emptyResult(zone: Zone, error: string | null): ZoneResult {
	return {
		zone,
		llmRequests: 0,
		llmRequestsPrev: 0,
		detections: { ...EMPTY_DETECTIONS },
		detectionsPrev: { ...EMPTY_DETECTIONS },
		series: [],
		seriesPrev: [],
		detectionSeries: [],
		detectionSeriesAvailable: { ...EMPTY_SERIES_AVAILABLE },
		seriesBucket: null,
		events: [],
		error,
		truncated: false,
	};
}

/**
 * Resolve the time-series dimension this zone can actually group by.
 *
 * The requested dimension comes from `bucketFor()` and every one of the four is present on
 * `httpRequestsAdaptiveGroups` today, so this normally returns the request unchanged. It exists
 * for the case where one disappears, and it differs from the two `... : 'datetimeHour'` fallbacks
 * it replaces in two ways that matter:
 *
 *   1. It steps to the next *coarser* dimension rather than jumping straight to hourly. Losing
 *      `datetimeFiveMinutes` on a 1-hour window used to collapse the chart to a single bucket;
 *      now it degrades to 15-minute.
 *   2. It reports the substitution, so `ZoneResult.seriesBucket` can be compared against
 *      `win.bucket` and the UI can say the granularity was reduced. The old fallbacks were
 *      silent, which is what made a schema change look like flat traffic.
 *
 * Returns null when the dataset exposes none of them — the caller then omits the series aliases
 * instead of querying a dimension that does not exist and losing the whole zone to a GraphQL error.
 */
function resolveBucket(caps: DatasetCaps, requested: string): string | null {
	const from = BUCKET_STEPS.findIndex((s) => s.dimension === requested);
	const candidates = from < 0 ? BUCKET_STEPS : BUCKET_STEPS.slice(from);
	return candidates.find((s) => caps.dimensions.includes(s.dimension))?.dimension ?? null;
}

/** Pick the first candidate field name that the dataset actually exposes. */
function pick(caps: DatasetCaps, ...candidates: string[]): string | null {
	return candidates.find((c) => caps.fields.includes(c)) ?? null;
}

function hasFilter(caps: DatasetCaps, name: string): boolean {
	return caps.filters.includes(name);
}

interface RowSelection {
	/** True when the dataset exposes `datetime`, which the row queries order by. */
	hasDatetime: boolean;
	selection: string;
}

/**
 * Build the selection set for per-request rows from fields that exist on the dataset.
 * Field naming differs slightly between datasets, hence the candidate lists.
 */
function buildRowSelection(caps: DatasetCaps, ai: SchemaCaps['ai']): RowSelection {
	const map: Record<string, string | null> = {
		datetime: pick(caps, 'datetime'),
		rayName: pick(caps, 'rayName', 'rayId'),
		clientIP: pick(caps, 'clientIP', 'clientIp'),
		country: pick(caps, 'clientCountryName', 'clientCountry'),
		asnDescription: pick(caps, 'clientASNDescription', 'clientAsnDescription'),
		ja4: pick(caps, 'ja4'),
		host: pick(caps, 'clientRequestHTTPHost', 'clientRequestHost'),
		path: pick(caps, 'clientRequestPath'),
		method: pick(caps, 'clientRequestHTTPMethodName', 'clientRequestHTTPMethod', 'clientRequestMethod'),
		status: pick(caps, 'edgeResponseStatus'),
		securityAction: pick(caps, 'securityAction', 'action'),
		sampleInterval: pick(caps, 'sampleInterval'),
		// Bare UUID, no readable-name mapping available without an API Shield permission this
		// token lacks — selected only so it can be shown as a raw "Endpoint ID" for correlation.
		operationId: pick(caps, 'webAssetsOperationId'),
		injectionScore: ai.injectionScore && caps.fields.includes(ai.injectionScore) ? ai.injectionScore : null,
		piiCategories: ai.piiCategories && caps.fields.includes(ai.piiCategories) ? ai.piiCategories : null,
		unsafeTopicCategories:
			ai.unsafeTopicCategories && caps.fields.includes(ai.unsafeTopicCategories) ? ai.unsafeTopicCategories : null,
		tokenCount: ai.tokenCount && caps.fields.includes(ai.tokenCount) ? ai.tokenCount : null,
		customTopicScoreMin:
			ai.customTopicScoresMin && caps.fields.includes(ai.customTopicScoresMin) ? ai.customTopicScoresMin : null,
	};

	// Alias every scalar field to a stable local name so the response shape never depends
	// on which Cloudflare naming variant this account's schema uses.
	const scalarSelection = Object.entries(map)
		.filter(([, remote]) => remote !== null)
		.map(([local, remote]) => (local === remote ? local : `${local}: ${remote}`))
		.join('\n          ');

	// firewallForAiCustomTopicCategories is an object array, not a scalar — it needs a
	// sub-selection ({ topicLabel score }), unlike every other field handled above.
	const customTopics =
		ai.customTopicCategories && caps.fields.includes(ai.customTopicCategories)
			? `\n          customTopics: ${ai.customTopicCategories} { topicLabel score }`
			: '';

	const selection = [scalarSelection, customTopics].filter(Boolean).join('\n          ');

	return { hasDatetime: map.datetime !== null, selection };
}

/**
 * `win.start` / `win.end` are interpolated directly into the GraphQL document below. That is
 * safe only because a TimeWindow is constructible in exactly two places — buildWindow() and
 * buildCustomWindow() in domain/params.ts — and both emit every timestamp through
 * `.toISOString()`. User-supplied text never reaches here: the custom-range picker's input is
 * validated by parseIsoMinute() and then re-serialised from epoch ms. A test asserts every
 * field of a custom window matches the ISO-instant shape, which is what pins that invariant.
 */
function baseFilter(caps: DatasetCaps, labelField: string | undefined, win: TimeWindow, prev = false): string[] {
	const parts: string[] = [];
	const start = prev ? win.prevStart : win.start;
	const end = prev ? win.prevEnd : win.end;

	if (hasFilter(caps, 'datetime_geq')) parts.push(`datetime_geq: "${start}"`);
	if (hasFilter(caps, 'datetime_leq')) parts.push(`datetime_leq: "${end}"`);
	if (hasFilter(caps, 'requestSource')) parts.push(`requestSource: "eyeball"`);

	const labelFilter = labelField ? `${labelField}_hasany` : null;
	if (labelFilter && hasFilter(caps, labelFilter)) parts.push(`${labelFilter}: ["${LLM_LABEL}"]`);

	return parts;
}

/**
 * "Detected" means the category array is non-empty. Prefer the `_isempty` operator:
 * it stays correct when Cloudflare adds new PII or unsafe-topic codes, whereas an
 * explicit `_hasany` list silently misses anything not yet in our catalog.
 */
function arrayNonEmptyFilter(caps: DatasetCaps, field: string | null, codes: string[]): string | null {
	if (!field) return null;
	if (hasFilter(caps, `${field}_isempty`)) return `${field}_isempty: false`;
	if (hasFilter(caps, `${field}_hasany`)) return `${field}_hasany: [${codes.map((c) => `"${c}"`).join(', ')}]`;
	return null;
}

function detectionFilters(caps: DatasetCaps, ai: SchemaCaps['ai']): Record<'injection' | 'pii' | 'unsafe' | 'custom', string | null> {
	const injection =
		ai.injectionScore && hasFilter(caps, `${ai.injectionScore}_lt`)
			? `${ai.injectionScore}_lt: ${INJECTION_ATTACK_THRESHOLD}`
			: null;

	// customTopicScoresMin is a scalar (100 = no custom topic matched), unlike the object-array
	// customTopicCategories field which has no filter operators at all. The `_lt` operator is
	// documented for scalars generally but not empirically verified here, so gate on hasFilter
	// like everything else — absent, this degrades to hidden rather than a guessed query shape.
	const custom =
		ai.customTopicScoresMin && hasFilter(caps, `${ai.customTopicScoresMin}_lt`)
			? `${ai.customTopicScoresMin}_lt: 100`
			: null;

	return {
		injection,
		pii: arrayNonEmptyFilter(caps, ai.piiCategories, Object.keys(PII_CATEGORIES)),
		unsafe: arrayNonEmptyFilter(caps, ai.unsafeTopicCategories, Object.keys(UNSAFE_TOPICS)),
		custom,
	};
}

interface ZoneQueryResponse {
	viewer: {
		zones: {
			llmTotal?: { count: number }[];
			llmPrev?: { count: number }[];
			injectionTotal?: { count: number }[];
			piiTotal?: { count: number }[];
			unsafeTotal?: { count: number }[];
			customTotal?: { count: number }[];
			injectionPrev?: { count: number }[];
			piiPrev?: { count: number }[];
			unsafePrev?: { count: number }[];
			customPrev?: { count: number }[];
			series?: { count: number; dimensions: Record<string, string> }[];
			seriesPrev?: { count: number; dimensions: Record<string, string> }[];
			injectionSeries?: { count: number; dimensions: Record<string, string> }[];
			piiSeries?: { count: number; dimensions: Record<string, string> }[];
			unsafeSeries?: { count: number; dimensions: Record<string, string> }[];
			customSeries?: { count: number; dimensions: Record<string, string> }[];
			injectionRows?: Record<string, unknown>[];
			piiRows?: Record<string, unknown>[];
			unsafeRows?: Record<string, unknown>[];
			customRows?: Record<string, unknown>[];
			payloads?: {
				rayName: string | null;
				description: string | null;
				metadata: { key: string; value: string }[] | null;
			}[];
		}[];
	};
}

function toEvent(zone: Zone, row: Record<string, unknown>): RawEvent {
	const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
	const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
	// Defensive: ignore malformed entries rather than let one bad row drop the whole array.
	const customTopics = (v: unknown): { topicLabel: string; score: number }[] =>
		Array.isArray(v)
			? v.filter(
					(x): x is { topicLabel: string; score: number } =>
						!!x && typeof x === 'object' && typeof (x as Record<string, unknown>).topicLabel === 'string' && typeof (x as Record<string, unknown>).score === 'number',
				)
			: [];

	return {
		zoneId: zone.id,
		zoneName: zone.name,
		datetime: str(row.datetime) ?? '',
		rayName: str(row.rayName),
		clientIP: str(row.clientIP),
		country: str(row.country),
		asnDescription: str(row.asnDescription),
		ja4: str(row.ja4),
		host: str(row.host),
		path: str(row.path),
		method: str(row.method),
		status: num(row.status),
		securityAction: str(row.securityAction),
		injectionScore: num(row.injectionScore),
		piiCategories: arr(row.piiCategories),
		unsafeTopicCategories: arr(row.unsafeTopicCategories),
		customTopics: customTopics(row.customTopics),
		customTopicScoreMin: num(row.customTopicScoreMin),
		tokenCount: num(row.tokenCount),
		sampleInterval: num(row.sampleInterval) ?? 1,
		payload: null,
		operationId: str(row.operationId),
	};
}

/** Fetch everything the dashboard needs for one zone in a single GraphQL round trip. */
async function fetchZone(env: AiSecEnv, schema: SchemaCaps, zone: Zone, win: TimeWindow): Promise<ZoneResult> {
	const groups = schema.datasets.httpRequestsAdaptiveGroups;
	const rowsDataset = schema.ai.dataset ? schema.datasets[schema.ai.dataset] : undefined;

	if (!groups && !rowsDataset) {
		return emptyResult(zone, 'No usable analytics dataset in schema');
	}

	const aliases: string[] = [];
	let detSeriesAvailable = { ...EMPTY_SERIES_AVAILABLE };

	if (groups) {
		const f = baseFilter(groups, schema.labelField.httpRequestsAdaptiveGroups, win);
		const fPrev = baseFilter(groups, schema.labelField.httpRequestsAdaptiveGroups, win, true);
		// null only if the dataset exposes none of the four time dimensions. The counts below
		// need no dimension, so they are still worth fetching; every alias that groups by one
		// is skipped rather than emitted against a dimension that does not exist, which would
		// fail the whole document and lose the zone.
		const bucket = resolveBucket(groups, win.bucket);
		const groupDet = detectionFilters(groups, schema.ai);

		aliases.push(`
        llmTotal: httpRequestsAdaptiveGroups(filter: { ${f.join(', ')} }, limit: 1) {
          count
        }
        llmPrev: httpRequestsAdaptiveGroups(filter: { ${fPrev.join(', ')} }, limit: 1) {
          count
        }`);

		if (bucket) {
			aliases.push(`
        series: httpRequestsAdaptiveGroups(
          filter: { ${f.join(', ')} }
          limit: 1000
          orderBy: [${bucket}_ASC]
        ) {
          count
          dimensions { ${bucket} }
        }
        seriesPrev: httpRequestsAdaptiveGroups(
          filter: { ${fPrev.join(', ')} }
          limit: 1000
          orderBy: [${bucket}_ASC]
        ) {
          count
          dimensions { ${bucket} }
        }`);
		}

		// Headline counts come from the aggregate dataset so they are exact, rather than
		// being inferred from the row list which is both sampled and capped.
		const countAlias = (alias: string, extra: string | null) =>
			extra ? `\n        ${alias}: httpRequestsAdaptiveGroups(filter: { ${[...f, extra].join(', ')} }, limit: 1) { count }` : '';

		// Same shape as countAlias but against fPrev — the previous-period counterpart, so the
		// detection KPI tiles get a period-over-period delta at zero extra round trips (same doc).
		const countAliasPrev = (alias: string, extra: string | null) =>
			extra ? `\n        ${alias}: httpRequestsAdaptiveGroups(filter: { ${[...fPrev, extra].join(', ')} }, limit: 1) { count }` : '';

		aliases.push(countAlias('injectionTotal', groupDet.injection));
		aliases.push(countAlias('piiTotal', groupDet.pii));
		aliases.push(countAlias('unsafeTotal', groupDet.unsafe));
		aliases.push(countAlias('customTotal', groupDet.custom));

		aliases.push(countAliasPrev('injectionPrev', groupDet.injection));
		aliases.push(countAliasPrev('piiPrev', groupDet.pii));
		aliases.push(countAliasPrev('unsafePrev', groupDet.unsafe));
		aliases.push(countAliasPrev('customPrev', groupDet.custom));

		// Same aggregate dataset, grouped by the same bucket as `series`, one alias per
		// detection filter — so the detection chart agrees with the KPI tiles even when the
		// row dataset hits its cap. A signal whose filter the schema doesn't expose gets no
		// alias here; detSeriesAvailable tells the caller to fall back to row-derived counts
		// for that signal only, instead of silently showing zeros.
		const seriesAlias = (alias: string, extra: string | null) =>
			extra && bucket
				? `\n        ${alias}: httpRequestsAdaptiveGroups(filter: { ${[...f, extra].join(', ')} }, limit: 1000, orderBy: [${bucket}_ASC]) {
          count
          dimensions { ${bucket} }
        }`
				: '';

		aliases.push(seriesAlias('injectionSeries', groupDet.injection));
		aliases.push(seriesAlias('piiSeries', groupDet.pii));
		aliases.push(seriesAlias('unsafeSeries', groupDet.unsafe));
		aliases.push(seriesAlias('customSeries', groupDet.custom));

		// A signal with no bucket dimension has no aggregate series to be available, so the
		// caller falls back to row-derived counts for all four rather than reading empty aliases.
		detSeriesAvailable = {
			injection: !!groupDet.injection && !!bucket,
			pii: !!groupDet.pii && !!bucket,
			unsafe: !!groupDet.unsafe && !!bucket,
			custom: !!groupDet.custom && !!bucket,
		};
	}

	if (rowsDataset) {
		const sel = buildRowSelection(rowsDataset, schema.ai);
		const f = baseFilter(rowsDataset, schema.labelField[schema.ai.dataset!], win);
		const det = detectionFilters(rowsDataset, schema.ai);
		const dsName = schema.ai.dataset!;
		const order = sel.hasDatetime ? '\n          orderBy: [datetime_DESC]' : '';

		const rowAlias = (alias: string, extra: string | null) => {
			if (!extra) return '';
			return `
        ${alias}: ${dsName}(
          filter: { ${[...f, extra].join(', ')} }
          limit: ${ROW_LIMIT}${order}
        ) {
          ${sel.selection}
        }`;
		};

		aliases.push(rowAlias('injectionRows', det.injection));
		aliases.push(rowAlias('piiRows', det.pii));
		aliases.push(rowAlias('unsafeRows', det.unsafe));
		// Without this, a request that matched ONLY a custom topic (no injection/PII/unsafe hit)
		// never surfaces in byRay below, so detection=custom would render an empty event list
		// even though the KPI tile shows a nonzero count.
		aliases.push(rowAlias('customRows', det.custom));
	}

	// Payload logging lives on firewall events, not HTTP requests: the Log Mode ruleset
	// attaches the encrypted prompt and the matched field names as event metadata.
	// Joined back onto the request rows by ray ID.
	const fw = schema.datasets.firewallEventsAdaptive;
	const rulesetId = logModeRuleset(env);
	// True when the rows coming back are guaranteed to be Log Mode events. When they are not,
	// the join below has to prove it per row from the metadata instead.
	let rulesetFiltered = false;
	if (fw && fw.fields.includes('metadata') && fw.fields.includes('rayName')) {
		const parts: string[] = [];
		if (hasFilter(fw, 'datetime_geq')) parts.push(`datetime_geq: "${win.start}"`);
		if (hasFilter(fw, 'datetime_leq')) parts.push(`datetime_leq: "${win.end}"`);
		if (rulesetId && hasFilter(fw, 'rulesetId')) {
			parts.push(`rulesetId: "${rulesetId}"`);
			rulesetFiltered = true;
		}

		if (parts.length) {
			aliases.push(`
        payloads: firewallEventsAdaptive(
          filter: { ${parts.join(', ')} }
          limit: ${ROW_LIMIT}
          orderBy: [datetime_DESC]
        ) {
          rayName
          description
          metadata { key value }
        }`);
		}
	}

	const body = aliases.filter(Boolean).join('\n');
	if (!body.trim()) {
		return emptyResult(zone, 'No queryable fields');
	}

	const query = `
query ZoneAiSecurity {
  viewer {
    zones(filter: { zoneTag: "${zone.id}" }) {${body}
    }
  }
}`;

	const { data, error } = await graphqlSafe<ZoneQueryResponse>(env, query);
	if (error || !data) {
		return emptyResult(zone, error ?? 'no data');
	}

	const z = data.viewer.zones[0];
	if (!z) {
		return emptyResult(zone, null);
	}

	// Resolved a second time rather than threaded down: same pure function, same inputs. Null
	// means no series was requested at all, in which case z.series is absent and this maps nothing.
	const bucketKey = groups ? resolveBucket(groups, win.bucket) : null;
	const toSeries = (rows: { count: number; dimensions: Record<string, string> }[] | undefined): SeriesPoint[] =>
		bucketKey ? (rows ?? []).map((p) => ({ ts: p.dimensions?.[bucketKey] ?? '', count: p.count })) : [];
	const series = toSeries(z.series);
	const seriesPrev = toSeries(z.seriesPrev);

	// The four detection-series aliases return separate row sets, each keyed by the same
	// bucket dimension as `series` — merge them per bucket into one point per timestamp.
	// A request that tripped several detectors is counted once per signal, so the four
	// numbers on a bucket overlap and their sum is not a request count.
	const detSeriesMap = new Map<string, DetectionSeriesPoint>();
	const addDetSeries = (rows: { count: number; dimensions: Record<string, string> }[] | undefined, key: 'injection' | 'pii' | 'unsafe' | 'custom') => {
		if (!bucketKey) return;
		for (const p of rows ?? []) {
			const ts = p.dimensions?.[bucketKey];
			if (!ts) continue;
			const slot = detSeriesMap.get(ts) ?? { ts, injection: 0, pii: 0, unsafe: 0, custom: 0 };
			slot[key] += p.count;
			detSeriesMap.set(ts, slot);
		}
	};
	addDetSeries(z.injectionSeries, 'injection');
	addDetSeries(z.piiSeries, 'pii');
	addDetSeries(z.unsafeSeries, 'unsafe');
	addDetSeries(z.customSeries, 'custom');
	const detectionSeries = [...detSeriesMap.values()].sort((a, b) => a.ts.localeCompare(b.ts));

	// A request can trip several detectors at once; dedupe on ray id so it is one event.
	const byRay = new Map<string, RawEvent>();
	const rowSets = [z.injectionRows, z.piiRows, z.unsafeRows, z.customRows];
	for (const rows of rowSets) {
		for (const row of rows ?? []) {
			const ev = toEvent(zone, row);
			const key = ev.rayName ?? `${ev.datetime}|${ev.clientIP}|${ev.path}`;
			if (!byRay.has(key)) byRay.set(key, ev);
		}
	}

	// Truncation is per detection type: a full page back from any one of them means the
	// breakdowns below are partial. Checking the deduped total instead would both miss
	// this and fire spuriously once three types sum past the cap.
	const truncated = rowSets.some((rows) => (rows?.length ?? 0) >= ROW_LIMIT);

	// One request can produce several Log Mode events (one per rule that fired), so merge
	// them per ray into a single payload record.
	for (const p of z.payloads ?? []) {
		if (!p.rayName) continue;
		const ev = byRay.get(p.rayName);
		if (!ev) continue;
		// Unfiltered scan: the row set is every firewall event in the window, so accept only the
		// ones carrying Log Mode's own metadata. Without this a block event for the same ray would
		// contribute its rule description and make the drawer claim a payload it does not have.
		// Skipped when the ruleset filter did the same job server-side — a Log Mode event whose
		// metadata is missing still has a rule name worth showing.
		if (!rulesetFiltered && !(p.metadata ?? []).some((m) => m.key === 'encrypted_matched_data' || m.key === 'matched_vars')) {
			continue;
		}

		const info: PayloadInfo = ev.payload ?? { rules: [], matchedVars: [], encrypted: null };
		if (p.description && !info.rules.includes(p.description)) info.rules.push(p.description);

		for (const { key, value } of p.metadata ?? []) {
			if (key === 'encrypted_matched_data') {
				info.encrypted ??= value;
			} else if (key === 'matched_vars') {
				try {
					for (const v of JSON.parse(value) as string[]) {
						if (!info.matchedVars.includes(v)) info.matchedVars.push(v);
					}
				} catch {
					// matched_vars is documented as a JSON array; ignore anything else.
				}
			}
		}

		ev.payload = info;
	}

	const count = (g?: { count: number }[]) => g?.[0]?.count ?? 0;

	return {
		zone,
		llmRequests: count(z.llmTotal),
		llmRequestsPrev: count(z.llmPrev),
		series,
		seriesPrev,
		detectionSeries,
		detectionSeriesAvailable: detSeriesAvailable,
		seriesBucket: bucketKey,
		detections: {
			injection: count(z.injectionTotal),
			pii: count(z.piiTotal),
			unsafe: count(z.unsafeTotal),
			custom: count(z.customTotal),
		},
		detectionsPrev: {
			injection: count(z.injectionPrev),
			pii: count(z.piiPrev),
			unsafe: count(z.unsafePrev),
			custom: count(z.customPrev),
		},
		events: [...byRay.values()],
		error: null,
		truncated,
	};
}

/**
 * Bump whenever the ZoneResult shape changes. ZoneResult is round-tripped through the Cache
 * API as JSON (see fetchZoneCached below), so a warm cache entry written by the previous
 * deploy is read back as-is — a field added in the new code (e.g. detectionsPrev) is simply
 * missing from it for up to the TTL, and a bare `r.detectionsPrev.injection` access throws.
 * Folding this into the key forces a cache miss (and a fresh, complete fetch) on every deploy
 * that changes the shape, instead of serving stale-shaped JSON until it expires.
 */
const RESULT_VERSION = 5;

/**
 * Quantized per-zone cache key.
 *
 * RELATIVE window: start/end are rounded to the current minute by buildWindow(), so keying on
 * them directly would mint a new key every minute and the cache would never hit — quantize to
 * a TTL-sized time slot instead. This string is byte-identical to the pre-custom-range one, so
 * warm entries survive the deploy that introduced absolute windows.
 *
 * ABSOLUTE window: key on the bounds themselves. Two separate claims, worth keeping apart:
 *   - Including start/end is a CORRECTNESS fix. Every custom window shares the same `key`
 *     ('custom'), so a key without the bounds would serve one custom window's rows for a
 *     completely different one.
 *   - Dropping the slot is an EFFICIENCY choice. A settled historical window cannot change, so
 *     re-fetching it once per TTL slot buys nothing.
 *
 * RESULT_VERSION is deliberately NOT bumped: the ZoneResult shape is unchanged by this.
 */
function zoneCacheKey(fp: string, zoneId: string, win: TimeWindow, ttlSeconds: number): Request {
	// The fingerprint is what keeps one operator's telemetry out of another's response; see the
	// note on Env.CF_TOKEN_FP. Two tokens can both see a zone and still be entitled to different
	// fields, so the zone id alone is not a sufficient key here.
	const base = `https://flarelens.internal/ai-sec/zone/${fp}/${zoneId}`;
	if (isAbsolute(win)) {
		return new Request(`${base}?range=custom&start=${win.start}&end=${win.end}&v=${RESULT_VERSION}`);
	}
	const slot = Math.floor(Date.now() / (ttlSeconds * 1000));
	return new Request(`${base}?range=${win.key}&slot=${slot}&v=${RESULT_VERSION}`);
}

/** ZoneResult is plain JSON-serializable data; round-trip it through the Cache API as JSON. */
async function fetchZoneCached(env: AiSecEnv, schema: SchemaCaps, zone: Zone, win: TimeWindow, waitUntil: WaitUntil, ttlSeconds: number): Promise<ZoneResult> {
	const cache = caches.default;
	const cacheKey = zoneCacheKey(env.CF_TOKEN_FP, zone.id, win, ttlSeconds);
	const hit = await cache.match(cacheKey);
	if (hit) return JSON.parse(await hit.text()) as ZoneResult;

	const result = await fetchZone(env, schema, zone, win);

	// Never cache a transient failure — pinning it for the TTL would keep showing the zone
	// as broken long after the underlying API call would have succeeded again.
	if (!result.error) {
		waitUntil(
			cache.put(
				cacheKey,
				new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttlSeconds}` },
				}),
			),
		);
	}
	return result;
}

/** Fan out across zones with a concurrency cap; a failing zone does not fail the page. */
export async function fetchAllZones(
	env: AiSecEnv,
	schema: SchemaCaps,
	zones: Zone[],
	win: TimeWindow,
	waitUntil: WaitUntil,
	ttlSeconds: number,
): Promise<ZoneResult[]> {
	const results: ZoneResult[] = [];
	const queue = [...zones];

	const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
		for (;;) {
			const zone = queue.shift();
			if (!zone) return;
			results.push(await fetchZoneCached(env, schema, zone, win, waitUntil, ttlSeconds));
		}
	});

	await Promise.all(workers);
	return results.sort((a, b) => a.zone.name.localeCompare(b.zone.name));
}

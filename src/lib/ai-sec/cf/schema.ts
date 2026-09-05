import { graphql } from './client';
import type { AiSecEnv } from './types';

/**
 * The Cloudflare GraphQL Analytics API exposes AI Security for Apps signals, but the
 * *GraphQL* field names for them are not documented — only the Logpush names are
 * (AISecurityInjectionScore, AISecurityPIICategories, AISecurityTokenCount,
 * AISecurityUnsafeTopicCategories). Rather than hardcode a guess, we introspect the
 * schema at runtime and resolve the real names, then build queries from what exists.
 *
 * Consequence: if Cloudflare renames or ships these fields on a different dataset,
 * the dashboard degrades to explicit empty-states instead of silently reporting zeros.
 */

const DATASETS = ['firewallEventsAdaptive', 'httpRequestsAdaptive', 'httpRequestsAdaptiveGroups'] as const;
export type DatasetName = (typeof DATASETS)[number];

export interface DatasetCaps {
	/** GraphQL type name of the dataset rows, e.g. "ZoneFirewallEventsAdaptive". */
	typeName: string;
	/** Selectable field names on the row type. */
	fields: string[];
	/** Selectable field names on the nested `dimensions` type, if the dataset has one. */
	dimensions: string[];
	/** Input field names accepted by the `filter` argument. */
	filters: string[];
}

export interface AiFieldMap {
	/** Dataset the AI Security fields were found on. */
	dataset: DatasetName | null;
	injectionScore: string | null;
	piiCategories: string | null;
	unsafeTopicCategories: string | null;
	tokenCount: string | null;
	/** Object-array field: [{ topicLabel, score }]. Null if the schema doesn't expose it. */
	customTopicCategories: string | null;
	/** Companion scalar: min score across the row's custom topic matches. */
	customTopicScoresMin: string | null;
}

export interface SchemaCaps {
	datasets: Partial<Record<DatasetName, DatasetCaps>>;
	/** AI field names resolved per dataset. */
	aiByDataset: Partial<Record<DatasetName, AiFieldMap>>;
	/** The dataset used for detection breakdowns and the event log. */
	ai: AiFieldMap;
	/** Managed endpoint label field (e.g. webAssetsLabelsManaged) per dataset. */
	labelField: Partial<Record<DatasetName, string>>;
	probedAt: string;
	/** Human-readable notes about anything missing, surfaced on /health. */
	notes: string[];
}

interface TypeRef {
	kind: string;
	name: string | null;
	ofType: TypeRef | null;
}

function unwrap(t: TypeRef | null | undefined): string | null {
	let cur: TypeRef | null | undefined = t;
	while (cur) {
		if (cur.name) return cur.name;
		cur = cur.ofType;
	}
	return null;
}

/**
 * The zone type is lowercase `zone` in Cloudflare's schema, and dataset fields are
 * wrapped as [Type!]! — so the ofType chain must be unwrapped several levels deep.
 */
const TYPE_REF = `kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

const ZONE_FIELDS_QUERY = `
query ProbeZone {
  __type(name: "zone") {
    fields {
      name
      type { ${TYPE_REF} }
      args {
        name
        type { ${TYPE_REF} }
      }
    }
  }
}`;

const TYPE_FIELDS_QUERY = `
query ProbeType($name: String!) {
  __type(name: $name) {
    fields {
      name
      type { ${TYPE_REF} }
    }
  }
}`;

const INPUT_FIELDS_QUERY = `
query ProbeInput($name: String!) {
  __type(name: $name) {
    inputFields { name }
  }
}`;

interface FieldsResponse {
	__type: {
		fields: { name: string; type: TypeRef; args?: { name: string; type: TypeRef }[] }[] | null;
	} | null;
}

interface InputFieldsResponse {
	__type: { inputFields: { name: string }[] | null } | null;
}

/** Case/format-insensitive key: lowercased, non-alphanumerics stripped. */
function norm(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find the first field whose normalized name contains every fragment. */
function findField(names: string[], ...fragments: string[]): string | null {
	const wanted = fragments.map(norm);
	return names.find((n) => wanted.every((f) => norm(n).includes(f))) ?? null;
}

async function probeDataset(env: AiSecEnv, zoneFields: FieldsResponse['__type'], dataset: DatasetName): Promise<DatasetCaps | null> {
	const field = zoneFields?.fields?.find((f) => f.name === dataset);
	if (!field) return null;

	const typeName = unwrap(field.type);
	if (!typeName) return null;

	const rowType = await graphql<FieldsResponse>(env, TYPE_FIELDS_QUERY, { name: typeName });
	const fields = rowType.__type?.fields ?? [];
	const fieldNames = fields.map((f) => f.name);

	let dimensions: string[] = [];
	const dimField = fields.find((f) => f.name === 'dimensions');
	if (dimField) {
		const dimTypeName = unwrap(dimField.type);
		if (dimTypeName) {
			const dimType = await graphql<FieldsResponse>(env, TYPE_FIELDS_QUERY, { name: dimTypeName });
			dimensions = (dimType.__type?.fields ?? []).map((f) => f.name);
		}
	}

	let filters: string[] = [];
	const filterArg = field.args?.find((a) => a.name === 'filter');
	const filterTypeName = unwrap(filterArg?.type);
	if (filterTypeName) {
		const filterType = await graphql<InputFieldsResponse>(env, INPUT_FIELDS_QUERY, { name: filterTypeName });
		filters = (filterType.__type?.inputFields ?? []).map((f) => f.name);
	}

	return { typeName, fields: fieldNames, dimensions, filters };
}

const NO_AI_FIELDS: AiFieldMap = {
	dataset: null,
	injectionScore: null,
	piiCategories: null,
	unsafeTopicCategories: null,
	tokenCount: null,
	customTopicCategories: null,
	customTopicScoresMin: null,
};

/**
 * Resolve AI Security field names on a single dataset.
 * Cloudflare has shipped these signals under both "AISecurity*" and "FirewallForAI*"
 * naming, so match on the distinctive suffix rather than the prefix.
 */
function resolveAiFieldsFor(ds: DatasetName, caps: DatasetCaps): AiFieldMap {
	const pool = [...caps.fields, ...caps.dimensions];
	const injectionScore = findField(pool, 'injectionscore');
	const piiCategories = findField(pool, 'piicategories');
	const unsafeTopicCategories = findField(pool, 'unsafetopiccategories');
	const tokenCount = findField(pool, 'tokencount');
	// Distinguish the object array `firewallForAiCustomTopicCategories` from its companion
	// scalar `firewallForAiCustomTopicCategoriesScoresMin` — "scoresmin" is a substring of
	// neither the other's normalized name, so matching on it first and excluding it below
	// keeps the two from colliding.
	const customTopicScoresMin = findField(pool, 'customtopiccategories', 'scoresmin');
	const customTopicCategories = findField(pool.filter((n) => n !== customTopicScoresMin), 'customtopiccategories');

	if (!injectionScore && !piiCategories && !unsafeTopicCategories) return NO_AI_FIELDS;
	return {
		dataset: ds,
		injectionScore,
		piiCategories,
		unsafeTopicCategories,
		tokenCount,
		customTopicCategories,
		customTopicScoresMin,
	};
}

export async function probeSchema(env: AiSecEnv): Promise<SchemaCaps> {
	const zoneProbe = await graphql<FieldsResponse>(env, ZONE_FIELDS_QUERY);
	const zoneFields = zoneProbe.__type;

	const datasets: Partial<Record<DatasetName, DatasetCaps>> = {};
	for (const ds of DATASETS) {
		const caps = await probeDataset(env, zoneFields, ds);
		if (caps) datasets[ds] = caps;
	}

	const aiByDataset: Partial<Record<DatasetName, AiFieldMap>> = {};
	for (const ds of DATASETS) {
		const caps = datasets[ds];
		if (!caps) continue;
		const resolved = resolveAiFieldsFor(ds, caps);
		if (resolved.dataset) aiByDataset[ds] = resolved;
	}

	// httpRequestsAdaptive is primary: it covers every cf-llm-labeled request, whereas
	// firewallEventsAdaptive only contains requests that actually matched a WAF rule
	// (so it is empty in Production Mode until you write rules).
	const ai = aiByDataset.httpRequestsAdaptive ?? aiByDataset.firewallEventsAdaptive ?? NO_AI_FIELDS;

	const labelField: Partial<Record<DatasetName, string>> = {};
	for (const ds of DATASETS) {
		const caps = datasets[ds];
		if (!caps) continue;
		const found = findField([...caps.fields, ...caps.dimensions], 'labelsmanaged');
		if (found) labelField[ds] = found;
	}

	const notes: string[] = [];
	for (const ds of DATASETS) {
		if (!datasets[ds]) notes.push(`Dataset ${ds} is not present in the schema for this token.`);
	}
	if (!ai.dataset) {
		notes.push(
			'No AI Security detection fields found in GraphQL. AI Security for Apps is an Enterprise add-on and must be enabled on the zone; detection breakdowns will be empty until it is.',
		);
	} else {
		if (!ai.injectionScore) notes.push(`Injection score field missing on ${ai.dataset}.`);
		if (!ai.piiCategories) notes.push(`PII categories field missing on ${ai.dataset}.`);
		if (!ai.unsafeTopicCategories) notes.push(`Unsafe topic categories field missing on ${ai.dataset}.`);
		if (!ai.tokenCount) {
			// Token count ships in Logpush but not in the GraphQL datasets; the KPI is hidden rather than shown as zero.
			notes.push(`Token count is not exposed on ${ai.dataset} in GraphQL (Logpush only) — the token KPI is hidden.`);
		}
	}
	if (!labelField.httpRequestsAdaptiveGroups && !labelField.httpRequestsAdaptive) {
		notes.push('Managed endpoint label field (webAssetsLabelsManaged) not found; cf-llm traffic cannot be isolated.');
	}

	return { datasets, aiByDataset, ai, labelField, notes, probedAt: new Date().toISOString() };
}

/**
 * Bump when the set of fields we resolve changes. The probe result is cached for an hour,
 * so without a version in the key a deploy that starts resolving a new field keeps serving
 * the old capability set until the TTL expires — the new column silently stays empty.
 */
const SCHEMA_VERSION = 2;
const schemaCacheKey = (fp: string) => `https://flarelens.internal/ai-sec/schema-caps/v${SCHEMA_VERSION}/${fp}`;
const SCHEMA_TTL_SECONDS = 3600;

/*
 * Keyed by token fingerprint, not a single slot. A Worker isolate is shared across requests
 * from different operators, so one bare module-level entry would hand the first caller's probe
 * result to everyone else on that isolate — schema capabilities differ by token scope, so that
 * is both wrong and a tenant leak.
 */
const memoryCache = new Map<string, { value: SchemaCaps; expires: number }>();

export type WaitUntil = (p: Promise<unknown>) => void;

/** Cached schema capabilities. Module memory first, then Cache API, then live probe. */
export async function getSchemaCaps(env: AiSecEnv, waitUntil: WaitUntil, force = false): Promise<SchemaCaps> {
	const now = Date.now();
	const key = schemaCacheKey(env.CF_TOKEN_FP);
	const memo = memoryCache.get(key);
	if (!force && memo && memo.expires > now) return memo.value;

	const cache = caches.default;
	if (!force) {
		const hit = await cache.match(key);
		if (hit) {
			const value = (await hit.json()) as SchemaCaps;
			memoryCache.set(key, { value, expires: now + SCHEMA_TTL_SECONDS * 1000 });
			return value;
		}
	}

	const value = await probeSchema(env);
	memoryCache.set(key, { value, expires: now + SCHEMA_TTL_SECONDS * 1000 });
	waitUntil(
		cache.put(
			key,
			new Response(JSON.stringify(value), {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${SCHEMA_TTL_SECONDS}` },
			}),
		),
	);
	return value;
}

/** Build the name of a filter operator input field, verifying it exists on the dataset. */
export function filterOp(caps: DatasetCaps, field: string, op: string): string | null {
	const candidate = `${field}_${op}`;
	return caps.filters.includes(candidate) ? candidate : null;
}

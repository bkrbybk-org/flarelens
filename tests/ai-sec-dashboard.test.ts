import { describe, expect, it } from "vitest";
import {
	buildDashboard,
	HEADLINE_KPI_IDS,
	CONTEXT_KPI_IDS,
	DETECTION_KPI_IDS,
} from "../src/lib/ai-sec/domain/transform";
import { buildWindow } from "../src/lib/ai-sec/domain/params";
import { event } from "./helpers/ai-sec-fixtures";
import type { ZoneResult } from "../src/lib/ai-sec/cf/queries";
import type { Zone } from "../src/lib/ai-sec/cf/types";

/**
 * Dedup in buildDashboard() keys events by `rayName ?? datetime|clientIP|path`. The shared
 * fixture defaults all three of those to the same value, so two bare `ev({...})` calls in
 * one test would silently collapse into one row via that dedup — not what most tests here want
 * to exercise. This wrapper stamps a unique rayName per call so each fixture stays a distinct
 * event unless a test overrides rayName itself (see the dedupe test below, which does exactly
 * that on purpose).
 */
let rayCounter = 0;
function ev(overrides: Partial<Parameters<typeof event>[0]> = {}): ReturnType<typeof event> {
	rayCounter++;
	return event({ rayName: `ray-${rayCounter}`, ...overrides });
}

/**
 * ZoneResult fixture helper, local to this file per the task instructions (only `ev()` is
 * shared). Defaults to an all-empty, non-erroring zone so each test states exactly the fields
 * it depends on, same rationale as the RawEvent fixture.
 */
function zoneResult(overrides: Partial<ZoneResult> = {}): ZoneResult {
	const zone: Zone = { id: "zone-1", name: "example.com" };
	return {
		zone,
		llmRequests: 0,
		llmRequestsPrev: 0,
		detections: { injection: 0, pii: 0, unsafe: 0, custom: 0 },
		detectionsPrev: { injection: 0, pii: 0, unsafe: 0, custom: 0 },
		series: [],
		seriesPrev: [],
		detectionSeries: [],
		detectionSeriesAvailable: { injection: false, pii: false, unsafe: false, custom: false },
		seriesBucket: null,
		events: [],
		error: null,
		truncated: false,
		...overrides,
	};
}

const win = buildWindow("1h", new Date("2026-09-04T10:00:00Z"));

describe("buildDashboard: KPI ids", () => {
	it("emits exactly llm + every DETECTION_KPI_IDS id on the headline row when custom topics are enabled", () => {
		const d = buildDashboard([zoneResult()], win, "all", { hasCustomTopics: true });
		const ids = d.kpis.map((k) => k.id);
		for (const id of HEADLINE_KPI_IDS) expect(ids).toContain(id);
	});

	it("hides the custom KPI when hasCustomTopics is not set, even if custom events exist", () => {
		const results = [zoneResult({ detections: { injection: 0, pii: 0, unsafe: 0, custom: 3 } })];
		const d = buildDashboard(results, win, "all", {});
		expect(d.kpis.map((k) => k.id)).not.toContain("custom");
	});

	it("hides the tokens KPI when hasTokenCount is not set", () => {
		const d = buildDashboard([zoneResult()], win, "all", {});
		expect(d.kpis.map((k) => k.id)).not.toContain("tokens");
	});

	it("shows tokens and ips as CONTEXT_KPI_IDS when hasTokenCount is set", () => {
		const d = buildDashboard([zoneResult()], win, "all", { hasTokenCount: true });
		const ids = d.kpis.map((k) => k.id);
		for (const id of CONTEXT_KPI_IDS) expect(ids).toContain(id);
	});

	it("produces zero-value, neutral-tone KPIs for a zone with no events", () => {
		const d = buildDashboard([zoneResult()], win, "all", { hasCustomTopics: true, hasTokenCount: true });
		for (const id of [...HEADLINE_KPI_IDS, ...CONTEXT_KPI_IDS]) {
			const kpi = d.kpis.find((k) => k.id === id)!;
			expect(kpi.value).toBe(0);
			expect(kpi.tone).toBe("neutral");
		}
	});

	it("computes headline detection KPIs from the aggregate `detections` counts, not from row events", () => {
		// KPI tiles must read the exact aggregate dataset, independent of what rows happened to
		// be fetched — the row list below intentionally disagrees with the aggregate counts.
		const results = [
			zoneResult({
				detections: { injection: 5, pii: 2, unsafe: 1, custom: 4 },
				events: [ev({ injectionScore: 1 })], // only 1 row, but aggregate says 5
			}),
		];
		const d = buildDashboard(results, win, "all", { hasCustomTopics: true });
		expect(d.kpis.find((k) => k.id === "injection")!.value).toBe(5);
		expect(d.kpis.find((k) => k.id === "pii")!.value).toBe(2);
		expect(d.kpis.find((k) => k.id === "unsafe")!.value).toBe(1);
		expect(d.kpis.find((k) => k.id === "custom")!.value).toBe(4);
	});

	it("sums llmRequests/llmRequestsPrev across zones for the llm KPI, prev included", () => {
		const results = [
			zoneResult({ llmRequests: 10, llmRequestsPrev: 6 }),
			zoneResult({ llmRequests: 3, llmRequestsPrev: 1 }),
		];
		const d = buildDashboard(results, win, "all");
		const llm = d.kpis.find((k) => k.id === "llm")!;
		expect(llm.value).toBe(13);
		expect(llm.prev).toBe(7);
	});

	it("gives a danger tone to injection when nonzero, warn to pii/unsafe/custom, neutral at zero", () => {
		const results = [zoneResult({ detections: { injection: 1, pii: 1, unsafe: 1, custom: 1 } })];
		const d = buildDashboard(results, win, "all", { hasCustomTopics: true });
		expect(d.kpis.find((k) => k.id === "injection")!.tone).toBe("danger");
		expect(d.kpis.find((k) => k.id === "pii")!.tone).toBe("warn");
		expect(d.kpis.find((k) => k.id === "unsafe")!.tone).toBe("warn");
		expect(d.kpis.find((k) => k.id === "custom")!.tone).toBe("warn");
	});

	it("counts distinct source IPs across allEvents (not the detection-filtered list) for the ips KPI", () => {
		const results = [
			zoneResult({
				events: [
					ev({ clientIP: "203.0.113.1" }),
					ev({ clientIP: "203.0.113.1" }), // repeat, must not double count
					ev({ clientIP: "203.0.113.2" }),
					ev({ clientIP: null }), // null must not count as a distinct IP
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.kpis.find((k) => k.id === "ips")!.value).toBe(2);
	});

	it("sums tokenCount * weight over allEvents for the tokens KPI when enabled", () => {
		const results = [
			zoneResult({
				events: [
					ev({ tokenCount: 100, sampleInterval: 1 }),
					ev({ tokenCount: 50, sampleInterval: 4 }), // stands for 4 requests
					ev({ tokenCount: null, sampleInterval: 1 }), // null tokenCount contributes 0
				],
			}),
		];
		const d = buildDashboard(results, win, "all", { hasTokenCount: true });
		expect(d.kpis.find((k) => k.id === "tokens")!.value).toBe(100 + 50 * 4);
	});

	it("wires kpiHref into each detection KPI's href, and leaves llm/ips/tokens unlinked", () => {
		const href = (t: string) => `/events?detection=${t}`;
		const d = buildDashboard([zoneResult()], win, "all", { kpiHref: href, hasTokenCount: true });
		expect(d.kpis.find((k) => k.id === "injection")!.href).toBe("/events?detection=injection");
		expect(d.kpis.find((k) => k.id === "pii")!.href).toBe("/events?detection=pii");
		expect(d.kpis.find((k) => k.id === "unsafe")!.href).toBe("/events?detection=unsafe");
		expect(d.kpis.find((k) => k.id === "llm")!.href).toBeUndefined();
		expect(d.kpis.find((k) => k.id === "ips")!.href).toBeUndefined();
		expect(d.kpis.find((k) => k.id === "tokens")!.href).toBeUndefined();
	});
});

describe("buildDashboard: DETECTION_KPI_IDS coverage", () => {
	it("every DETECTION_KPI_IDS entry appears as a KPI id when all capability flags are on", () => {
		const d = buildDashboard([zoneResult()], win, "all", { hasCustomTopics: true });
		const ids = d.kpis.map((k) => k.id);
		for (const id of DETECTION_KPI_IDS) expect(ids).toContain(id);
	});
});

describe("buildDashboard: sampling weight", () => {
	it("weights topCountries/topIps/topAsns/topTargets tallies by sampleInterval", () => {
		const results = [
			zoneResult({
				events: [
					ev({ country: "TH", clientIP: "1.1.1.1", asnDescription: "AS1", host: "a.com", path: "/x", sampleInterval: 10 }),
					ev({ country: "TH", clientIP: "1.1.1.1", asnDescription: "AS1", host: "a.com", path: "/x", sampleInterval: 1 }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.topCountries.find((c) => c.key === "TH")!.count).toBe(11);
		expect(d.topIps.find((c) => c.key === "1.1.1.1")!.count).toBe(11);
		expect(d.topAsns.find((c) => c.key === "AS1")!.count).toBe(11);
		expect(d.topTargets.find((c) => c.key === "a.com/x")!.count).toBe(11);
	});

	it("treats sampleInterval <= 0 as weight 1, per the weight() floor", () => {
		const results = [
			zoneResult({
				events: [
					ev({ country: "SG", sampleInterval: 0 }),
					ev({ country: "SG", sampleInterval: -5 }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		// Both events fall back to weight 1, so the country tally is 2, not 0 or negative.
		expect(d.topCountries.find((c) => c.key === "SG")!.count).toBe(2);
	});

	it("reports rows/sampledRows/maxInterval in the sampling disclosure", () => {
		const results = [
			zoneResult({
				events: [
					ev({ sampleInterval: 1 }),
					ev({ sampleInterval: 5 }),
					ev({ sampleInterval: 20 }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.sampling.rows).toBe(3);
		expect(d.sampling.sampledRows).toBe(2); // only the two with weight > 1
		expect(d.sampling.maxInterval).toBe(20);
	});

	it("reports maxInterval 1 and sampledRows 0 when no row is sampled", () => {
		const results = [zoneResult({ events: [ev({ sampleInterval: 1 }), ev({ sampleInterval: 1 })] })];
		const d = buildDashboard(results, win, "all");
		expect(d.sampling).toEqual({ rows: 2, sampledRows: 0, maxInterval: 1 });
	});
});

describe("buildDashboard: BuildOptions.sessionKey", () => {
	const results = [
		zoneResult({
			events: [
				// Same JA4, two different IPs — a rotating attacker.
				ev({ clientIP: "9.9.9.1", ja4: "fp-A", country: "TH", datetime: "2026-09-04T09:10:00Z" }),
				ev({ clientIP: "9.9.9.2", ja4: "fp-A", country: "TH", datetime: "2026-09-04T09:20:00Z" }),
				// Different JA4 entirely.
				ev({ clientIP: "9.9.9.3", ja4: "fp-B", country: "SG", datetime: "2026-09-04T09:15:00Z" }),
			],
		}),
	];

	it("defaults to grouping attackerSessions by IP, giving 3 separate rows", () => {
		const d = buildDashboard(results, win, "all");
		expect(d.sessionKey).toBe("ip");
		expect(d.attackerSessions).toHaveLength(3);
		expect(d.attackerSessions.every((r) => r.distinctIps === 1)).toBe(true);
	});

	it("groups by ja4 when sessionKey is 'ja4', collapsing rotated IPs into one row with distinctIps > 1", () => {
		const d = buildDashboard(results, win, "all", { sessionKey: "ja4" });
		expect(d.sessionKey).toBe("ja4");
		expect(d.attackerSessions).toHaveLength(2);
		const fpA = d.attackerSessions.find((r) => r.ja4 === "fp-A")!;
		expect(fpA.distinctIps).toBe(2);
		expect(fpA.requests).toBe(2);
	});

	it("echoes the requested sessionKey on the dashboard even when the grouped field is always null", () => {
		// opts.sessionKey trusts the caller; a schema without asn resolution would produce ja4-less
		// data here, and the dashboard must still report what was asked for, per the BuildOptions doc.
		const noAsn = [zoneResult({ events: [ev({ asnDescription: null, clientIP: "1.2.3.4" })] })];
		const d = buildDashboard(noAsn, win, "all", { sessionKey: "asn" });
		expect(d.sessionKey).toBe("asn");
		expect(d.attackerSessions).toHaveLength(0); // no event has a non-null asnDescription to key on
	});

	it("records firstSeen/lastSeen as the min/max datetime within a session group", () => {
		const d = buildDashboard(results, win, "all", { sessionKey: "ja4" });
		const fpA = d.attackerSessions.find((r) => r.ja4 === "fp-A")!;
		expect(fpA.firstSeen).toBe("2026-09-04T09:10:00Z");
		expect(fpA.lastSeen).toBe("2026-09-04T09:20:00Z");
	});
});

describe("buildDashboard: BuildOptions.endpointKey", () => {
	const results = [
		zoneResult({
			events: [
				ev({ host: "a.example.com", path: "/v1/chat", injectionScore: 1 }),
				ev({ host: "a.example.com", path: "/v2/chat", piiCategories: ["EMAIL"] }),
				ev({ host: "b.example.com", path: "/v1/chat", unsafeTopicCategories: ["S1"] }),
			],
		}),
	];

	it("defaults to grouping by host+path (target), producing 3 distinct rows", () => {
		const d = buildDashboard(results, win, "all");
		expect(d.endpointBreakdown).toHaveLength(3);
		expect(d.endpointBreakdown.every((r) => r.host && r.path)).toBe(true);
	});

	it("groups by host alone when endpointKey is 'host', collapsing same-host rows and blanking path", () => {
		const d = buildDashboard(results, win, "all", { endpointKey: "host" });
		expect(d.endpointBreakdown).toHaveLength(2);
		const a = d.endpointBreakdown.find((r) => r.host === "a.example.com")!;
		expect(a.path).toBe("");
		expect(a.total).toBe(2); // one injection + one pii event
	});

	it("groups by path alone when endpointKey is 'path', collapsing same-path rows across hosts and blanking host", () => {
		const d = buildDashboard(results, win, "all", { endpointKey: "path" });
		const chatRow = d.endpointBreakdown.find((r) => r.path === "/v1/chat")!;
		expect(chatRow.host).toBe("");
		expect(chatRow.total).toBe(2); // a.example.com and b.example.com both hit /v1/chat
	});

	it("excludes an event with no host under host/target grouping, but keeps it under path grouping", () => {
		const noHost = [zoneResult({ events: [ev({ host: null, path: "/orphan", injectionScore: 1 })] })];
		const target = buildDashboard(noHost, win, "all", { endpointKey: "target" });
		const byHost = buildDashboard(noHost, win, "all", { endpointKey: "host" });
		const byPath = buildDashboard(noHost, win, "all", { endpointKey: "path" });
		expect(target.endpointBreakdown).toHaveLength(0);
		expect(byHost.endpointBreakdown).toHaveLength(0);
		expect(byPath.endpointBreakdown).toHaveLength(1);
		expect(byPath.endpointBreakdown[0].path).toBe("/orphan");
	});

	it("orders endpointBreakdown rows by total descending", () => {
		const busy = [
			zoneResult({
				events: [
					ev({ host: "quiet.com", path: "/x", injectionScore: 1 }),
					ev({ host: "busy.com", path: "/y", injectionScore: 1 }),
					ev({ host: "busy.com", path: "/y", piiCategories: ["EMAIL"] }),
				],
			}),
		];
		const d = buildDashboard(busy, win, "all", { endpointKey: "host" });
		expect(d.endpointBreakdown.map((r) => r.host)).toEqual(["busy.com", "quiet.com"]);
	});
});

describe("buildDashboard: time bucketing of detectionSeries", () => {
	it("buckets detectionSeries against the full bucketGrid, zero-filling empty buckets", () => {
		// win is a 1h window at five-minute buckets -> 13 grid points (both ends inclusive).
		const results = [
			zoneResult({
				detectionSeriesAvailable: { injection: false, pii: false, unsafe: false, custom: false },
				events: [ev({ datetime: "2026-09-04T09:35:00Z", injectionScore: 1 })],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.detectionSeries).toHaveLength(13);
		const bucket = d.detectionSeries.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!;
		expect(bucket.injection).toBe(1);
		// Every other bucket must be an explicit zero, not just absent.
		const others = d.detectionSeries.filter((p) => p.ts !== "2026-09-04T09:35:00.000Z");
		expect(others.every((p) => p.injection === 0 && p.pii === 0 && p.unsafe === 0 && p.custom === 0)).toBe(true);
	});

	it("prefers the aggregate detectionSeries over the row-derived one when the signal is available on every healthy zone", () => {
		const results = [
			zoneResult({
				detectionSeriesAvailable: { injection: true, pii: false, unsafe: false, custom: false },
				detectionSeries: [{ ts: "2026-09-04T09:35:00Z", injection: 99, pii: 0, unsafe: 0, custom: 0 }],
				// Row list disagrees on purpose, to prove the aggregate wins for injection.
				events: [ev({ datetime: "2026-09-04T09:35:00Z", injectionScore: 1 })],
			}),
		];
		const d = buildDashboard(results, win, "all");
		const bucket = d.detectionSeries.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!;
		expect(bucket.injection).toBe(99); // aggregate value, not the row-derived 1
	});

	it("falls back to the row-derived series for a signal an errored zone cannot vote on", () => {
		// One healthy zone claims injection is available, but a second zone errored outright;
		// healthyResults excludes it, so availability is judged on the survivor alone. Here the
		// survivor says it is NOT available, so the whole vote must fall back to row-derived counts.
		const results = [
			zoneResult({
				detectionSeriesAvailable: { injection: false, pii: false, unsafe: false, custom: false },
				events: [ev({ datetime: "2026-09-04T09:35:00Z", injectionScore: 1 })],
			}),
			zoneResult({ error: "zone unreachable" }),
		];
		const d = buildDashboard(results, win, "all");
		const bucket = d.detectionSeries.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!;
		expect(bucket.injection).toBe(1); // row-derived fallback
	});

	it("truncates a bucketTs mismatch correctly: an aggregate point outside the grid step still lands on the right bucket", () => {
		const results = [
			zoneResult({
				detectionSeriesAvailable: { injection: true, pii: true, unsafe: true, custom: true },
				detectionSeries: [{ ts: "2026-09-04T09:37:12Z", injection: 4, pii: 0, unsafe: 0, custom: 0 }],
			}),
		];
		const d = buildDashboard(results, win, "all");
		// 09:37:12 truncates to the 09:35 five-minute bucket.
		const bucket = d.detectionSeries.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!;
		expect(bucket.injection).toBe(4);
	});
});

describe("buildDashboard: breakdown/rollup tables with empty input", () => {
	it("produces empty tables (not a throw) for zero results", () => {
		const d = buildDashboard([], win, "all");
		expect(d.topicBreakdown).toEqual([]);
		expect(d.piiBreakdown).toEqual([]);
		expect(d.customBreakdown).toEqual([]);
		expect(d.topCountries).toEqual([]);
		expect(d.topAsns).toEqual([]);
		expect(d.topIps).toEqual([]);
		expect(d.topTargets).toEqual([]);
		expect(d.endpointBreakdown).toEqual([]);
		expect(d.countryBreakdown).toEqual([]);
		expect(d.zoneRollup).toEqual([]);
		expect(d.attackerSessions).toEqual([]);
		expect(d.mitigations).toEqual([]);
		expect(d.mitigationCoverage).toEqual({ combos: [], total: 0 });
		expect(d.sampling).toEqual({ rows: 0, sampledRows: 0, maxInterval: 1 });
		expect(d.events).toEqual([]);
		expect(d.totalEvents).toBe(0);
		expect(d.zonesWithErrors).toEqual([]);
		expect(d.bucketFallback).toBeNull();
		expect(d.truncated).toBe(false);
	});

	it("produces empty tables for a single zone with zero events, without throwing", () => {
		const d = buildDashboard([zoneResult()], win, "all");
		expect(d.topicBreakdown).toEqual([]);
		expect(d.endpointBreakdown).toEqual([]);
		expect(d.countryBreakdown).toEqual([]);
		expect(d.attackerSessions).toEqual([]);
		// One zone rollup row still exists — it always mirrors `results`, even with no events.
		expect(d.zoneRollup).toHaveLength(1);
		expect(d.zoneRollup[0]).toMatchObject({ zoneId: "zone-1", llmRequests: 0, error: null });
	});

	it("orders topicBreakdown/piiBreakdown/customBreakdown by count descending", () => {
		const results = [
			zoneResult({
				events: [
					ev({ unsafeTopicCategories: ["S1"] }),
					ev({ unsafeTopicCategories: ["S1"] }),
					ev({ unsafeTopicCategories: ["S2"] }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.topicBreakdown.map((c) => c.key)).toEqual(["S1", "S2"]);
		expect(d.topicBreakdown[0].count).toBe(2);
	});

	it("orders countryBreakdown by requests descending and tracks maxSeverity per country", () => {
		const results = [
			zoneResult({
				events: [
					ev({ country: "TH", injectionScore: 5 }), // critical (score < 10)
					ev({ country: "SG", piiCategories: ["DATE_TIME"] }), // low severity category
					ev({ country: "SG", piiCategories: ["DATE_TIME"] }),
					ev({ country: "SG", piiCategories: ["DATE_TIME"] }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.countryBreakdown.map((c) => c.code)).toEqual(["SG", "TH"]); // SG has 3 requests > TH's 1
		expect(d.countryBreakdown.find((c) => c.code === "TH")!.maxSeverity).toBe("critical");
		expect(d.countryBreakdown.find((c) => c.code === "SG")!.maxSeverity).toBe("low");
	});
});

describe("buildDashboard: zone errors do not fail the whole dashboard", () => {
	it("keeps healthy zones' data when one zone errored, and lists the error in zonesWithErrors", () => {
		const results = [
			zoneResult({
				llmRequests: 5,
				detections: { injection: 1, pii: 0, unsafe: 0, custom: 0 },
				events: [ev({ injectionScore: 1 })],
			}),
			zoneResult({ zone: { id: "zone-2", name: "broken.com" }, error: "GraphQL 500" }),
		];
		expect(() => buildDashboard(results, win, "all")).not.toThrow();
		const d = buildDashboard(results, win, "all");
		expect(d.kpis.find((k) => k.id === "injection")!.value).toBe(1); // healthy zone's count survives
		expect(d.zonesWithErrors).toEqual([{ zoneName: "broken.com", error: "GraphQL 500" }]);
	});

	it("still emits a zoneRollup row for the errored zone, carrying its error and zero counts", () => {
		const results = [zoneResult({ zone: { id: "zone-2", name: "broken.com" }, error: "GraphQL 500" })];
		const d = buildDashboard(results, win, "all");
		expect(d.zoneRollup).toEqual([
			{ zoneId: "zone-2", zoneName: "broken.com", llmRequests: 0, injection: 0, pii: 0, unsafe: 0, custom: 0, error: "GraphQL 500" },
		]);
	});

	it("produces an entirely empty, non-throwing dashboard when every zone errored", () => {
		const results = [
			zoneResult({ zone: { id: "z1", name: "one.com" }, error: "timeout" }),
			zoneResult({ zone: { id: "z2", name: "two.com" }, error: "timeout" }),
		];
		expect(() => buildDashboard(results, win, "all")).not.toThrow();
		const d = buildDashboard(results, win, "all");
		expect(d.zonesWithErrors).toHaveLength(2);
		expect(d.kpis.every((k) => k.value === 0)).toBe(true);
	});
});

describe("buildDashboard: dedupe, narrowing and totalEvents", () => {
	it("dedupes events across zones by rayName", () => {
		const shared = event({ rayName: "ray-1", injectionScore: 1 });
		const results = [zoneResult({ events: [shared] }), zoneResult({ zone: { id: "z2", name: "two.com" }, events: [shared] })];
		const d = buildDashboard(results, win, "all");
		expect(d.totalEvents).toBe(1);
	});

	it("applies opts.narrow to `events` but not to the allEvents-derived breakdowns", () => {
		const results = [
			zoneResult({
				events: [
					ev({ country: "TH", injectionScore: 1 }),
					ev({ country: "SG", injectionScore: 1 }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all", { narrow: { country: ["TH"] } });
		expect(d.events).toHaveLength(1); // narrowed
		expect(d.totalEvents).toBe(1);
		// countryBreakdown must still show both countries — narrowing must not rewrite it.
		expect(d.countryBreakdown.map((c) => c.code).sort()).toEqual(["SG", "TH"]);
	});

	it("filters `events` by the requested detection type but leaves allEvents-derived tables alone", () => {
		const results = [
			zoneResult({
				events: [ev({ injectionScore: 1 }), ev({ piiCategories: ["EMAIL"] })],
			}),
		];
		const d = buildDashboard(results, win, "injection");
		expect(d.events).toHaveLength(1);
		expect(d.topicBreakdown).toEqual([]); // unaffected structurally; just confirms no throw/crash path
		expect(d.piiBreakdown).toHaveLength(1); // built from allEvents, still sees the pii event
	});
});

describe("buildDashboard: mitigations and mitigationCoverage", () => {
	it("produces no mitigations and zero coverage total when nothing was detected", () => {
		const d = buildDashboard([zoneResult()], win, "all");
		expect(d.mitigations).toEqual([]);
		expect(d.mitigationCoverage).toEqual({ combos: [], total: 0 });
	});

	it("excludes an already-terminated event from mitigationCoverage but still counts it in mitigations' blocked total", () => {
		const results = [
			zoneResult({
				events: [ev({ injectionScore: 1, securityAction: "block" })],
			}),
		];
		const d = buildDashboard(results, win, "all");
		const injectionMitigation = d.mitigations.find((m) => m.kind === "injection")!;
		expect(injectionMitigation.count).toBe(1);
		expect(injectionMitigation.blocked).toBe(1);
		expect(injectionMitigation.unmitigated).toBe(0);
		// The event was already terminated, so it contributes no mask to the coverage simulator.
		expect(d.mitigationCoverage).toEqual({ combos: [], total: 0 });
	});

	it("groups mitigationCoverage by the SET of signals an unmitigated event carries, not per-signal sums", () => {
		const results = [
			zoneResult({
				events: [
					// One event carrying both pii and unsafe should land in ONE combo bucket, not two.
					ev({ piiCategories: ["EMAIL"], unsafeTopicCategories: ["S1"] }),
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.mitigationCoverage.combos).toHaveLength(1);
		expect(d.mitigationCoverage.total).toBe(1);
	});
});

describe("buildDashboard: trafficSeries and trafficSeriesPrev", () => {
	it("zero-fills trafficSeries across the full grid and sums merged points across zones", () => {
		const results = [
			zoneResult({ series: [{ ts: "2026-09-04T09:35:00Z", count: 3 }] }),
			zoneResult({ zone: { id: "z2", name: "two.com" }, series: [{ ts: "2026-09-04T09:35:00Z", count: 2 }] }),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.trafficSeries).toHaveLength(13);
		expect(d.trafficSeries.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!.count).toBe(5);
		expect(d.trafficSeries.filter((p) => p.ts !== "2026-09-04T09:35:00.000Z").every((p) => p.count === 0)).toBe(true);
	});

	it("shifts trafficSeriesPrev forward by the window span so it aligns index-for-index with trafficSeries", () => {
		// win spans 09:00Z..10:00Z, so the equivalent previous-window point one span earlier
		// (08:35Z) should land on trafficSeries' 09:35 bucket once shifted forward.
		const results = [zoneResult({ seriesPrev: [{ ts: "2026-09-04T08:35:00Z", count: 7 }] })];
		const d = buildDashboard(results, win, "all");
		expect(d.trafficSeriesPrev).toHaveLength(d.trafficSeries.length);
		expect(d.trafficSeriesPrev.map((p) => p.ts)).toEqual(d.trafficSeries.map((p) => p.ts));
		expect(d.trafficSeriesPrev.find((p) => p.ts === "2026-09-04T09:35:00.000Z")!.count).toBe(7);
	});
});

describe("buildDashboard: injectionHistogram and injectionScores", () => {
	it("emits all INJECTION_BUCKETS labels, zero-filled, weighted by sampleInterval", () => {
		const results = [
			zoneResult({
				events: [
					ev({ injectionScore: 5, sampleInterval: 3 }), // "1–19 (likely attack)"
					ev({ injectionScore: 100 }), // "Not scored"
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.injectionHistogram).toHaveLength(6); // one entry per INJECTION_BUCKETS row
		expect(d.injectionHistogram.find((b) => b.key === "1–19 (likely attack)")!.count).toBe(3);
		expect(d.injectionHistogram.find((b) => b.key === "Not scored")!.count).toBe(1);
		const untouched = d.injectionHistogram.filter((b) => b.key !== "1–19 (likely attack)" && b.key !== "Not scored");
		expect(untouched.every((b) => b.count === 0)).toBe(true);
	});

	it("excludes the 100 (unscored) sentinel and null scores from injectionScores, sorted ascending", () => {
		const results = [
			zoneResult({
				events: [
					ev({ injectionScore: 42, sampleInterval: 2 }),
					ev({ injectionScore: 42, sampleInterval: 1 }),
					ev({ injectionScore: 5 }),
					ev({ injectionScore: 100 }), // excluded: unscored sentinel
					ev({ injectionScore: null }), // excluded: no score at all
				],
			}),
		];
		const d = buildDashboard(results, win, "all");
		expect(d.injectionScores).toEqual([
			{ score: 5, count: 1 },
			{ score: 42, count: 3 },
		]);
	});
});

describe("buildDashboard: bucketFallback", () => {
	it("is null when every zone's seriesBucket matches the requested window bucket", () => {
		const results = [zoneResult({ seriesBucket: win.bucket })];
		const d = buildDashboard(results, win, "all");
		expect(d.bucketFallback).toBeNull();
	});

	it("is null when seriesBucket is absent (nothing queried) rather than treating that as a fallback", () => {
		const results = [zoneResult({ seriesBucket: null })];
		const d = buildDashboard(results, win, "all");
		expect(d.bucketFallback).toBeNull();
	});

	it("reports the substituted dimension and the affected zone names when a zone used a coarser bucket", () => {
		const results = [zoneResult({ seriesBucket: "datetimeHour" })]; // win.bucket is 'datetimeFiveMinutes' for a 1h window
		const d = buildDashboard(results, win, "all");
		expect(d.bucketFallback).toEqual({ requested: win.bucket, used: "datetimeHour", zones: ["example.com"] });
	});
});

describe("buildDashboard: truncated", () => {
	it("is true if any zone's row query was truncated", () => {
		const results = [zoneResult({ truncated: false }), zoneResult({ zone: { id: "z2", name: "two.com" }, truncated: true })];
		const d = buildDashboard(results, win, "all");
		expect(d.truncated).toBe(true);
	});

	it("is false when no zone truncated", () => {
		const d = buildDashboard([zoneResult({ truncated: false })], win, "all");
		expect(d.truncated).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import {
	BUCKET_STEPS,
	DEFAULT_RANGE,
	GRID_MINUTES,
	MAX_LOOKBACK_MINUTES,
	RANGES,
	bucketFor,
	buildCustomWindow,
	buildWindow,
	cacheTtl,
	isAbsolute,
	parseIsoMinute,
	type RangeKey,
} from "../src/lib/ai-sec/domain/params";

/**
 * Unit cover for the window/parameter layer of AI Security.
 *
 * The module's own comments say a test pins the preset→bucket mapping and the ISO parsing
 * rules; the script they refer to did not come across with the port, so these are it.
 */

describe("bucketFor", () => {
	it("maps every preset to the bucket the module documents", () => {
		// Pinned deliberately: the thresholds are not "finest bucket under N points", and
		// rederiving them that way silently rebuckets the 6h chart.
		expect(bucketFor(RANGES["30m"].minutes)).toBe("datetimeFiveMinutes");
		expect(bucketFor(RANGES["1h"].minutes)).toBe("datetimeFiveMinutes");
		expect(bucketFor(RANGES["3h"].minutes)).toBe("datetimeFifteenMinutes");
		expect(bucketFor(RANGES["6h"].minutes)).toBe("datetimeFifteenMinutes");
		expect(bucketFor(RANGES["12h"].minutes)).toBe("datetimeFifteenMinutes");
		expect(bucketFor(RANGES["24h"].minutes)).toBe("datetimeHour");
		expect(bucketFor(RANGES["7d"].minutes)).toBe("datetimeHour");
		expect(bucketFor(RANGES["30d"].minutes)).toBe("date");
	});

	it("is inclusive at each threshold and steps up one past it", () => {
		for (const step of BUCKET_STEPS) {
			if (!Number.isFinite(step.maxMinutes)) continue;
			expect(bucketFor(step.maxMinutes)).toBe(step.dimension);
			expect(bucketFor(step.maxMinutes + 1)).not.toBe(step.dimension);
		}
	});

	it("falls back to the coarsest bucket beyond the last threshold", () => {
		expect(bucketFor(Number.MAX_SAFE_INTEGER)).toBe("date");
	});

	it("keeps every bucket name inside the set bucketTs understands", () => {
		// A name outside this set falls through bucketTs's default and is silently hourly.
		const known = new Set(["date", "datetimeFiveMinutes", "datetimeFifteenMinutes", "datetimeHour"]);
		for (const step of BUCKET_STEPS) expect(known.has(step.dimension)).toBe(true);
	});
});

describe("buildWindow", () => {
	const now = new Date("2026-09-04T10:07:33.512Z");

	it("truncates the end to the minute, dropping seconds and millis", () => {
		expect(buildWindow("1h", now).end).toBe("2026-09-04T10:07:00.000Z");
	});

	it("spans exactly the preset's minutes", () => {
		for (const key of Object.keys(RANGES) as RangeKey[]) {
			const win = buildWindow(key, now);
			const span = Date.parse(win.end) - Date.parse(win.start);
			expect(span).toBe(RANGES[key].minutes * 60_000);
		}
	});

	it("places the previous period immediately before the current one, same length", () => {
		const win = buildWindow("6h", now);
		expect(win.prevEnd).toBe(win.start);
		expect(Date.parse(win.prevEnd) - Date.parse(win.prevStart)).toBe(RANGES["6h"].minutes * 60_000);
	});

	it("emits every bound through toISOString, which cf/queries.ts interpolates directly", () => {
		const win = buildWindow("24h", now);
		for (const value of [win.start, win.end, win.prevStart, win.prevEnd]) {
			expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(new Date(value).toISOString()).toBe(value);
		}
	});

	it("is not absolute, and the default preset exists", () => {
		expect(isAbsolute(buildWindow(DEFAULT_RANGE, now))).toBe(false);
		expect(RANGES[DEFAULT_RANGE]).toBeDefined();
	});

	it("caps the longest preset at the documented lookback limit", () => {
		expect(RANGES["30d"].minutes).toBe(MAX_LOOKBACK_MINUTES);
	});
});

describe("parseIsoMinute", () => {
	it("accepts the forms the picker and the app emit", () => {
		expect(parseIsoMinute("2026-08-12T10:30Z")).toBe(Date.parse("2026-08-12T10:30:00Z"));
		expect(parseIsoMinute("2026-08-12T10:30:00Z")).toBe(Date.parse("2026-08-12T10:30:00Z"));
		expect(parseIsoMinute("2026-08-12T10:30:00.500Z")).toBe(Date.parse("2026-08-12T10:30:00.500Z"));
	});

	it("treats a bare datetime-local value as UTC, not the host timezone", () => {
		// Spec says bare means LOCAL. On a Worker local === UTC, so honouring that would make
		// results correct in prod and TZ-dependent in this suite.
		expect(parseIsoMinute("2026-08-12T10:30")).toBe(Date.parse("2026-08-12T10:30:00Z"));
	});

	it("rejects an explicit offset rather than converting it", () => {
		expect(parseIsoMinute("2026-08-12T10:30+07:00")).toBeNull();
	});

	it("rejects junk, overlong input and non-dates", () => {
		expect(parseIsoMinute("")).toBeNull();
		expect(parseIsoMinute("yesterday")).toBeNull();
		expect(parseIsoMinute("2026-13-45T99:99Z")).toBeNull();
		expect(parseIsoMinute(`2026-08-12T10:30Z${" ".repeat(40)}`)).toBeNull();
	});

	it("bounds work before parsing, so a huge string cannot reach the Date parser", () => {
		expect(parseIsoMinute("2".repeat(10_000))).toBeNull();
	});
});

describe("buildCustomWindow", () => {
	const start = Date.parse("2026-08-12T10:32:00Z");
	const end = Date.parse("2026-08-12T16:33:00Z");

	it("snaps both bounds to the 5-minute grid that bounds cache fragmentation", () => {
		const win = buildCustomWindow(start, end);
		for (const value of [win.start, win.end]) {
			expect(Date.parse(value) % (GRID_MINUTES * 60_000)).toBe(0);
		}
		expect(win.start).toBe("2026-08-12T10:30:00.000Z");
		expect(win.end).toBe("2026-08-12T16:35:00.000Z");
	});

	it("is absolute and picks its bucket from the snapped span", () => {
		const win = buildCustomWindow(start, end);
		expect(isAbsolute(win)).toBe(true);
		expect(win.bucket).toBe("datetimeFifteenMinutes");
	});

	it("keeps the toISOString invariant for custom windows too", () => {
		const win = buildCustomWindow(start, end);
		for (const value of [win.start, win.end, win.prevStart, win.prevEnd]) {
			expect(new Date(value).toISOString()).toBe(value);
		}
	});

	it("puts the previous period immediately before the window, same span", () => {
		const win = buildCustomWindow(start, end);
		expect(win.prevEnd).toBe(win.start);
		const span = Date.parse(win.end) - Date.parse(win.start);
		expect(Date.parse(win.prevEnd) - Date.parse(win.prevStart)).toBe(span);
	});
});

describe("cacheTtl", () => {
	const now = new Date("2026-09-04T10:00:00Z");

	it("caches settled history far longer than a trailing window", () => {
		const custom = buildCustomWindow(Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-02T00:00:00Z"));
		expect(cacheTtl(custom)).toBe(300);
	});

	it("uses a shorter TTL for the fastest-moving preset", () => {
		expect(cacheTtl(buildWindow("30m", now))).toBe(30);
		expect(cacheTtl(buildWindow("24h", now))).toBe(60);
	});

	it("never caches longer than the caller's refresh interval", () => {
		expect(cacheTtl(buildWindow("24h", now), 30)).toBe(30);
		// A slower refresh must not stretch the TTL past the base.
		expect(cacheTtl(buildWindow("24h", now), 90)).toBe(60);
	});
});

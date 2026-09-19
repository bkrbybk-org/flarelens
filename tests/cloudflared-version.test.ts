import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compareCloudflaredVersions,
	fetchLatestCloudflaredRelease,
	getLatestCloudflaredCached,
	monthsBetween,
	parseCloudflaredVersion,
	versionBehindNote,
} from "../src/lib/cloudflared-version";

describe("parseCloudflaredVersion / compareCloudflaredVersions", () => {
	it("parses YYYY.M.P, tolerant of a leading v", () => {
		expect(parseCloudflaredVersion("2026.9.1")).toEqual({ year: 2026, month: 9, patch: 1 });
		expect(parseCloudflaredVersion("v2026.9.1")).toEqual({ year: 2026, month: 9, patch: 1 });
	});

	it("returns null for anything not shaped like a cloudflared version", () => {
		expect(parseCloudflaredVersion("not-a-version")).toBeNull();
		expect(parseCloudflaredVersion("1.2.3")).toBeNull();
		expect(parseCloudflaredVersion("")).toBeNull();
	});

	it("compares numerically, not lexically — 2026.10.1 is newer than 2026.9.1", () => {
		expect(compareCloudflaredVersions("2026.9.1", "2026.10.1")).toBe(-1);
		expect(compareCloudflaredVersions("2026.10.1", "2026.9.1")).toBe(1);
		expect(compareCloudflaredVersions("2026.6.0", "2026.6.1")).toBe(-1);
		expect(compareCloudflaredVersions("2026.6.1", "2026.6.1")).toBe(0);
	});

	it("returns null (not a claim) when either side is unparsable", () => {
		expect(compareCloudflaredVersions("garbage", "2026.9.1")).toBeNull();
		expect(compareCloudflaredVersions("2026.9.1", "garbage")).toBeNull();
	});
});

describe("monthsBetween", () => {
	it("counts whole calendar months, spanning a year boundary", () => {
		expect(monthsBetween({ year: 2026, month: 6, patch: 0 }, { year: 2026, month: 9, patch: 1 })).toBe(3);
		expect(monthsBetween({ year: 2025, month: 11, patch: 0 }, { year: 2026, month: 2, patch: 0 })).toBe(3);
	});
});

describe("versionBehindNote", () => {
	const latest = { version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" };

	it("is null when the connector is current or newer", () => {
		expect(versionBehindNote("2026.9.1", latest)).toBeNull();
		expect(versionBehindNote("2026.10.0", latest)).toBeNull();
	});

	it("is info-level for a moderately old version", () => {
		const note = versionBehindNote("2026.6.0", latest);
		expect(note).toEqual({ level: "info", message: "Running cloudflared 2026.6.0; latest is 2026.9.1, about 3 months behind." });
	});

	it("is warn-level once ~6 months behind", () => {
		const note = versionBehindNote("2025.3.0", { version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
		expect(note?.level).toBe("warn");
		expect(note?.message).toContain("18 months behind");
	});

	it("is null when the connector version cannot be parsed", () => {
		expect(versionBehindNote("unknown", latest)).toBeNull();
	});

	it("is null when the latest release itself could not be determined", () => {
		expect(versionBehindNote("2026.6.0", { error: "rate limited" })).toBeNull();
	});
});

describe("fetchLatestCloudflaredRelease", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the version and publish date on a normal response", async () => {
		globalThis.fetch = vi.fn(async (input, init) => {
			expect(String(input)).toBe("https://api.github.com/repos/cloudflare/cloudflared/releases/latest");
			expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("flarelens");
			return new Response(JSON.stringify({ tag_name: "2026.9.1", published_at: "2026-09-01T00:00:00Z", prerelease: false }), { status: 200 });
		}) as typeof fetch;
		const result = await fetchLatestCloudflaredRelease();
		expect(result).toEqual({ version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
	});

	it("degrades to an error on a non-200 (e.g. rate limited), never throwing", async () => {
		globalThis.fetch = vi.fn(async () => new Response("rate limited", { status: 403 })) as typeof fetch;
		const result = await fetchLatestCloudflaredRelease();
		expect("error" in result).toBe(true);
	});

	it("degrades to an error on a network failure, never throwing", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const result = await fetchLatestCloudflaredRelease();
		expect(result).toEqual({ error: "network down" });
	});

	it("degrades to an error when the tag is unparsable", async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "garbage", published_at: "2026-09-01T00:00:00Z" }), { status: 200 })) as typeof fetch;
		const result = await fetchLatestCloudflaredRelease();
		expect("error" in result).toBe(true);
	});
});

describe("getLatestCloudflaredCached", () => {
	beforeEach(() => {
		(globalThis as { caches?: unknown }).caches = undefined;
	});
	afterEach(() => {
		(globalThis as { caches?: unknown }).caches = undefined;
		vi.restoreAllMocks();
	});

	it("serves a cached entry without calling fetch again", async () => {
		const store = new Map<string, string>();
		(globalThis as { caches?: unknown }).caches = {
			default: {
				match: async (key: string) => {
					const raw = store.get(key);
					return raw ? new Response(raw) : undefined;
				},
				put: async (key: string, res: Response) => {
					store.set(key, await res.text());
				},
			},
		};
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: "2026.9.1", published_at: "2026-09-01T00:00:00Z" }), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		let pending: Promise<unknown> = Promise.resolve();
		const waitUntil = (p: Promise<unknown>) => {
			pending = p;
		};
		const first = await getLatestCloudflaredCached(waitUntil);
		await pending;
		expect(first).toEqual({ version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const second = await getLatestCloudflaredCached(waitUntil);
		expect(second).toEqual({ version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
		expect(fetchMock).toHaveBeenCalledTimes(1); // no second upstream call
	});

	it("falls back to a live fetch when caches is unavailable, without throwing", async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "2026.9.1", published_at: "2026-09-01T00:00:00Z" }), { status: 200 })) as typeof fetch;
		const result = await getLatestCloudflaredCached((p) => p);
		expect(result).toEqual({ version: "2026.9.1", publishedAt: "2026-09-01T00:00:00Z" });
	});

	it("does not cache an error result, so the next request retries", async () => {
		const store = new Map<string, string>();
		(globalThis as { caches?: unknown }).caches = {
			default: {
				match: async (key: string) => {
					const raw = store.get(key);
					return raw ? new Response(raw) : undefined;
				},
				put: async (key: string, res: Response) => {
					store.set(key, await res.text());
				},
			},
		};
		globalThis.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as typeof fetch;
		await getLatestCloudflaredCached((p) => p);
		expect(store.size).toBe(0);
	});
});

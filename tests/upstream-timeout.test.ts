import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMEOUT_MARKER_HEADER, upstreamFetch } from "../src/lib/cf-rest";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** A fetch that never answers on its own — only an abort ends it, as a stalled upstream would. */
function stalledFetch() {
	return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
		}),
	) as unknown as typeof fetch;
}

describe("upstreamFetch", () => {
	it("turns a stalled request into a 504 in Cloudflare's error shape, marked as a timeout", async () => {
		globalThis.fetch = stalledFetch();
		const res = await upstreamFetch("https://api.cloudflare.com/client/v4/zones", {}, 20);
		expect(res.status).toBe(504);
		expect(res.headers.get(TIMEOUT_MARKER_HEADER)).toBe("1");
		const body = (await res.json()) as { success: boolean; errors: { message: string }[] };
		expect(body.success).toBe(false);
		expect(body.errors[0].message).toBe("api.cloudflare.com did not answer within 0.02s");
	});

	it("passes a normal response through untouched", async () => {
		globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
		const res = await upstreamFetch("https://api.cloudflare.com/client/v4/zones");
		expect(res.status).toBe(200);
		expect(res.headers.get(TIMEOUT_MARKER_HEADER)).toBeNull();
	});

	it("still throws when the caller aborts, or the network fails", async () => {
		globalThis.fetch = stalledFetch();
		const caller = new AbortController();
		const pending = upstreamFetch("https://api.cloudflare.com/x", { signal: caller.signal }, 10_000);
		caller.abort();
		await expect(pending).rejects.toBeDefined();

		globalThis.fetch = vi.fn(async () => {
			throw new TypeError("network down");
		}) as typeof fetch;
		await expect(upstreamFetch("https://api.cloudflare.com/x")).rejects.toThrow("network down");
	});
});

describe("every upstream call is bounded", () => {
	// A raw fetch to Cloudflare can wait as long as the platform allows, which is how a single
	// stalled read once held the whole Tunnel Map open. Everything goes through upstreamFetch.
	// The two exceptions set their own tighter timeouts and are pinned by their own tests.
	const OWN_TIMEOUT = new Set(["src/lib/cf-rest.ts", "src/lib/cloudflared-version.ts", "src/lib/tunnel-metrics.ts"]);

	function files(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
		});
	}

	it("has no raw fetch outside the bounded client", () => {
		const root = join(import.meta.dirname, "..");
		const offenders = files(join(root, "src"))
			.map((path) => path.slice(root.length + 1))
			.filter((rel) => !OWN_TIMEOUT.has(rel))
			.filter((rel) => /(?<![\w.])fetch\(/.test(readFileSync(join(root, rel), "utf8")));
		expect(offenders).toEqual([]);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTunnelMetrics, parsePrometheusMetrics, parseTunnelMetricsConfig, validateMetricsUrl } from "../src/lib/tunnel-metrics";

const TUNNEL_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTOR_ID = "22222222-2222-2222-2222-222222222222";

describe("validateMetricsUrl", () => {
	it("accepts a well-formed https URL ending in /metrics", () => {
		const result = validateMetricsUrl("https://metrics-a.example.com/metrics");
		expect(result.ok).toBe(true);
	});

	it("rejects http:", () => {
		expect(validateMetricsUrl("http://metrics-a.example.com/metrics")).toEqual({ ok: false, reason: "must use https:" });
	});

	it("rejects credentials in the URL", () => {
		expect(validateMetricsUrl("https://user:pass@metrics-a.example.com/metrics").ok).toBe(false);
	});

	it("rejects an IP literal host", () => {
		expect(validateMetricsUrl("https://203.0.113.5/metrics").ok).toBe(false);
		expect(validateMetricsUrl("https://[::1]/metrics").ok).toBe(false);
	});

	it("rejects localhost", () => {
		expect(validateMetricsUrl("https://localhost/metrics").ok).toBe(false);
		expect(validateMetricsUrl("https://localhost./metrics").ok).toBe(false);
		expect(validateMetricsUrl("https://metrics.localhost/metrics").ok).toBe(false);
		// URL normalises decimal and bracketed forms to literals, which the literal check catches.
		expect(validateMetricsUrl("https://2130706433/metrics").ok).toBe(false);
		expect(validateMetricsUrl("https://[::1]/metrics").ok).toBe(false);
	});

	it("rejects a path that does not end with /metrics", () => {
		expect(validateMetricsUrl("https://metrics-a.example.com/admin").ok).toBe(false);
	});

	it("rejects a malformed URL", () => {
		expect(validateMetricsUrl("not a url").ok).toBe(false);
	});
});

describe("parseTunnelMetricsConfig", () => {
	it("is empty for an unset secret", () => {
		const config = parseTunnelMetricsConfig(undefined);
		expect(config.byTunnelId.size).toBe(0);
		expect(config.invalid).toEqual([]);
	});

	it("parses a valid entry, keyed by lowercased tunnel id", () => {
		const config = parseTunnelMetricsConfig(
			JSON.stringify([{ tunnelId: TUNNEL_ID.toUpperCase(), connectorId: CONNECTOR_ID, url: "https://metrics-a.example.com/metrics" }]),
		);
		expect(config.byTunnelId.get(TUNNEL_ID)).toEqual({
			tunnelId: TUNNEL_ID.toUpperCase(),
			connectorId: CONNECTOR_ID,
			url: "https://metrics-a.example.com/metrics",
		});
		expect(config.invalid).toEqual([]);
	});

	it("reports (not throws) invalid JSON", () => {
		const config = parseTunnelMetricsConfig("{not json");
		expect(config.byTunnelId.size).toBe(0);
		expect(config.invalid[0].reason).toMatch(/not valid JSON/);
	});

	it("reports a non-array top level", () => {
		const config = parseTunnelMetricsConfig(JSON.stringify({ tunnelId: TUNNEL_ID, url: "https://a/metrics" }));
		expect(config.invalid[0].reason).toMatch(/must be a JSON array/);
	});

	it("rejects an entry with http:, an IP literal, localhost, userinfo, or the wrong path — reported, not fetched", () => {
		const config = parseTunnelMetricsConfig(
			JSON.stringify([
				{ tunnelId: TUNNEL_ID, url: "http://metrics-a.example.com/metrics" },
				{ tunnelId: TUNNEL_ID, url: "https://203.0.113.5/metrics" },
				{ tunnelId: TUNNEL_ID, url: "https://localhost/metrics" },
				{ tunnelId: TUNNEL_ID, url: "https://u:p@metrics-a.example.com/metrics" },
				{ tunnelId: TUNNEL_ID, url: "https://metrics-a.example.com/status" },
			]),
		);
		expect(config.byTunnelId.size).toBe(0);
		expect(config.invalid).toHaveLength(5);
		for (const entry of config.invalid) expect(entry.reason).toMatch(/^url /);
	});

	it("rejects a bad tunnelId without throwing", () => {
		const config = parseTunnelMetricsConfig(JSON.stringify([{ tunnelId: "not-an-id", url: "https://a.example.com/metrics" }]));
		expect(config.byTunnelId.size).toBe(0);
		expect(config.invalid[0].reason).toMatch(/tunnelId/);
	});
});

describe("parsePrometheusMetrics", () => {
	const fixture = `
# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 12.34
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 5.2428e+07
process_start_time_seconds 1.757260800e+09
cloudflared_tunnel_ha_connections{tunnel_id="abc"} 4
cloudflared_tunnel_total_requests{tunnel_id="abc",status_code="200"} 100
cloudflared_tunnel_total_requests{tunnel_id="abc",status_code="502"} 3
cloudflared_tunnel_request_errors{tunnel_id="abc"} 3
cloudflared_tunnel_concurrent_requests_per_tunnel{tunnel_id="abc"} 2
go_memstats_alloc_bytes 123456
some_unrelated_metric NaN
another_bad_line +Inf
`;

	it("extracts the wanted metrics, summing across label sets, ignoring HELP/TYPE/comments/unrelated metrics", () => {
		const result = parsePrometheusMetrics(fixture);
		expect(result.processCpuSecondsTotal).toBeCloseTo(12.34);
		expect(result.processResidentMemoryBytes).toBeCloseTo(52428000, -2);
		expect(result.processStartTimeSeconds).toBeCloseTo(1757260800);
		expect(result.haConnections).toBe(4);
		expect(result.totalRequests).toBe(103); // 100 + 3, summed across label sets
		expect(result.requestErrors).toBe(3);
		expect(result.concurrentRequests).toBe(2);
	});

	it("rejects NaN and non-finite values rather than propagating them", () => {
		const result = parsePrometheusMetrics("process_cpu_seconds_total NaN\nprocess_resident_memory_bytes +Inf\n");
		expect(result.processCpuSecondsTotal).toBeUndefined();
		expect(result.processResidentMemoryBytes).toBeUndefined();
	});

	it("returns an empty object for empty or garbage input", () => {
		expect(parsePrometheusMetrics("")).toEqual({});
		expect(parsePrometheusMetrics("not metrics at all, just text")).toEqual({});
	});
});

describe("fetchTunnelMetrics", () => {
	afterEach(() => vi.restoreAllMocks());

	const target = { tunnelId: TUNNEL_ID, url: "https://metrics-a.example.com/metrics" };

	it("parses a happy-path response", async () => {
		globalThis.fetch = vi.fn(async (_input, init) => {
			expect((init?.headers as Record<string, string>)["CF-Access-Client-Id"]).toBe("cid");
			expect((init?.headers as Record<string, string>)["CF-Access-Client-Secret"]).toBe("csecret");
			expect(init?.redirect).toBe("manual");
			return new Response("process_resident_memory_bytes 1024\ncloudflared_tunnel_ha_connections 4\n", {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			});
		}) as typeof fetch;
		const result = await fetchTunnelMetrics(target, { clientId: "cid", clientSecret: "csecret" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.metrics.processResidentMemoryBytes).toBe(1024);
			expect(result.metrics.haConnections).toBe(4);
		}
	});

	it("treats a redirect (Access login page) as access-denied, not a followed redirect", async () => {
		globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login" } })) as typeof fetch;
		const result = await fetchTunnelMetrics(target, {});
		expect(result).toEqual({ ok: false, error: { kind: "access-denied" } });
	});

	it("treats 401/403 as access-denied", async () => {
		globalThis.fetch = vi.fn(async () => new Response("denied", { status: 401 })) as typeof fetch;
		const result = await fetchTunnelMetrics(target, {});
		expect(result).toEqual({ ok: false, error: { kind: "access-denied" } });
	});

	it("caps the response body and errors as too-large rather than buffering it fully", async () => {
		const bigChunk = new Uint8Array(1024 * 1024); // 1 MiB per chunk, several chunks exceeds the 2 MiB cap
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 3) {
					controller.close();
					return;
				}
				sent++;
				controller.enqueue(bigChunk);
			},
		});
		globalThis.fetch = vi.fn(
			async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/plain" } }),
		) as typeof fetch;
		const result = await fetchTunnelMetrics(target, {});
		expect(result).toEqual({ ok: false, error: { kind: "too-large" } });
	});

	it("refuses to fetch a misconfigured target at all", async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;
		const result = await fetchTunnelMetrics({ tunnelId: TUNNEL_ID, url: "http://not-https.example.com/metrics" }, {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("misconfigured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a timeout distinctly", async () => {
		globalThis.fetch = vi.fn(async () => {
			const err = new Error("timed out");
			err.name = "TimeoutError";
			throw err;
		}) as typeof fetch;
		const result = await fetchTunnelMetrics(target, {});
		expect(result).toEqual({ ok: false, error: { kind: "timeout" } });
	});

	it("reports a non-metrics content type distinctly", async () => {
		globalThis.fetch = vi.fn(async () => new Response("<html>not metrics</html>", { status: 200, headers: { "Content-Type": "text/html" } })) as typeof fetch;
		const result = await fetchTunnelMetrics(target, {});
		expect(result).toEqual({ ok: false, error: { kind: "not-metrics" } });
	});
});

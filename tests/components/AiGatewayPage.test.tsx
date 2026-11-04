import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiGatewayPage } from "../../web/src/features/ai-gateway/AiGatewayPage";
import type { Session } from "../../web/src/hooks/useSession";
import type { TimeRange } from "../../web/src/hooks/useTimeRange";
import type { AiGatewayBreakdownRow, AiGatewayUsageResult } from "../../web/src/features/ai-gateway/types";
import type * as ApiClientModule from "../../web/src/api/client";

vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchAiGatewayUsage: vi.fn() };
});

import { fetchAiGatewayUsage } from "../../web/src/api/client";

/** The AI Gateway overview: headline changes, and drilling into a slice and back out. */

const session: Session = { token: "tok", accountId: "acc1", accountName: "Acme", mode: "byot" };
const timeRange: TimeRange = {
	minutes: 7 * 24 * 60,
	preset: "7d" as TimeRange["preset"],
	setPreset: () => {},
	clamp: (max) => ({ minutes: Math.min(7 * 24 * 60, max), clamped: false }),
	bounds: () => ({ from: "2026-10-28T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" }),
};

const slice = (key: string, requests: number, extra: Partial<AiGatewayBreakdownRow> = {}): AiGatewayBreakdownRow => ({
	key,
	requests,
	tokensIn: 100,
	tokensOut: 10,
	cost: 0.5,
	errors: 0,
	cached: 0,
	p50: 1200,
	p95: 5000,
	...extra,
});

const usage: AiGatewayUsageResult = {
	granularity: "daily",
	timeDimension: "date",
	series: [{ ts: "2026-11-03", requests: 10, tokens: 110, cost: 0.5, errors: 0 }],
	seriesBy: {
		gateway: [
			{ ts: "2026-11-03", key: "prod", requests: 7, tokens: 77, cost: 0.35, errors: 0 },
			{ ts: "2026-11-03", key: "staging", requests: 3, tokens: 33, cost: 0.15, errors: 0 },
		],
		model: [{ ts: "2026-11-03", key: "@cf/a", requests: 10, tokens: 110, cost: 0.5, errors: 0 }],
		provider: [
			{ ts: "2026-11-03", key: "workers-ai", requests: 8, tokens: 90, cost: 0.4, errors: 0 },
			{ ts: "2026-11-03", key: "openai", requests: 2, tokens: 20, cost: 0.1, errors: 0 },
		],
		client: [{ ts: "2026-11-03", key: "opencode", requests: 10, tokens: 110, cost: 0.5, errors: 0 }],
	},
	totals: {
		requests: 10,
		tokensIn: 100,
		tokensOut: 10,
		cost: 0.5,
		errors: 0,
		errorRate: 0,
		cacheHits: 2,
		cacheMisses: 8,
		cacheHitRate: 0.2,
		p50: 1200,
		p95: 5000,
		rateLimited: 0,
		users: 0,
		sessions: 4,
		promptCache: { readTokens: 40, inputTokens: 140, requestsWithRead: 5 },
	},
	byGateway: [slice("prod", 7), slice("staging", 3)],
	byProvider: [slice("workers-ai", 10)],
	byModel: [slice("@cf/a", 10)],
	byStatus: [{ statusCode: "200", rateLimited: false, requests: 10 }],
	byClient: [slice("opencode", 10)],
	sessionHealth: {
		available: true,
		sessions: 4,
		basis: "all",
		flags: { abnormalCost: 1, abnormalDuration: 0, lowCacheHit: 0, highFirstContext: 0, highMcpTools: null, premiumModel: 0, thinkingModel: 0 },
	},
	recent: [
		{ requestId: "r1", datetime: "2026-11-03T10:05:00Z", gateway: "prod", provider: "workers-ai", model: "@cf/a", statusCode: "200", durationMs: 1200, cached: false, rateLimited: false, tokensIn: 10, tokensOut: 1, cost: 0.05, userAgent: "app/1" },
	],
	previous: { requests: 5, sessions: 2, tokens: 55, cost: 0.25, errorRate: 0, cacheHitRate: 0.6, p50: 1200 },
	previousWindow: { since: "2026-10-21T00:00:00.000Z", until: "2026-10-28T00:00:00.000Z" },
	filter: {},
	truncated: false,
	datasets: { errors: { available: true }, cache: { available: true }, spend: { available: true } },
};

beforeEach(() => {
	history.replaceState(null, "", "#/ai-gateway");
	vi.mocked(fetchAiGatewayUsage).mockReset();
	vi.mocked(fetchAiGatewayUsage).mockResolvedValue(usage);
});

describe("AiGatewayPage", () => {
	it("shows each headline against the previous window", async () => {
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const requests = (await screen.findByText("Requests", { selector: "div" })).closest("div[class*='rounded-xl']")!;
		expect(requests).toHaveTextContent("▲ 2.0×");
		// A rate changes by points, coloured by direction: the cache hit rate fell 40 points.
		expect(screen.getByText("Cache hit rate").closest("div[class*='rounded-xl']")).toHaveTextContent("▼ 40.0 pts");
		expect(screen.getByText("Cache hit rate fell from 60% to 20% since the previous window", { exact: false })).toBeInTheDocument();
	});

	it("adds prompt cache, sessions, active days, a spend line, clients, provider names and session health", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const card = (label: string) => screen.getByText(label, { selector: "div" }).closest("div[class*='rounded-xl']")!;
		expect(await screen.findByText("Prompt cache", { selector: "div" })).toBeInTheDocument();
		expect(card("Prompt cache")).toHaveTextContent("28.6%");
		expect(card("Prompt cache")).toHaveTextContent("40 of 140 input tokens read from the provider's cache · 50.0% of requests");
		expect(card("Sessions")).toHaveTextContent("4no user ids sent · ▲ 2.0×");
		expect(card("Active days")).toHaveTextContent("1 of 7");
		expect(card("Active days")).toHaveTextContent("$0.50 and 10 requests per active day");
		expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("Spend (right axis)$0.50");
		// Clients: named, not drillable.
		const breakdown = screen.getByRole("heading", { name: "Breakdown" }).closest("section")!;
		await user.click(within(breakdown).getByRole("tab", { name: "Clients" }));
		expect(within(breakdown).getByText("opencode")).toBeInTheDocument();
		expect(within(breakdown).queryByRole("button", { name: "opencode" })).toBeNull();
		// Providers by their names, drilled by their ids.
		await user.click(within(breakdown).getByRole("tab", { name: "Providers" }));
		await user.click(within(breakdown).getByRole("button", { name: "Workers AI" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { provider: "workers-ai" } });
		const health = screen.getByRole("heading", { name: "Session health" }).closest("section")!;
		expect(health).toHaveTextContent("4 sessions analysed by AI Gateway");
		expect(health).toHaveTextContent("Unusually expensive1 (25.0%)");
		// A flag the schema lacks is left out, not shown as zero.
		expect(health).not.toHaveTextContent("Heavy MCP tool use");
	});

	it("picks the timeframe on the page, and buckets a week by day", async () => {
		const setPreset = vi.fn();
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={{ ...timeRange, setPreset }} onAuthError={vi.fn()} />);
		expect(vi.mocked(fetchAiGatewayUsage).mock.calls[0][1]).toMatchObject({ granularity: "daily" });
		const frames = screen.getByRole("group", { name: "Timeframe" });
		expect(within(frames).getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
		await user.click(within(frames).getByRole("button", { name: "24 hours" }));
		expect(setPreset).toHaveBeenCalledWith("24h");
		expect(await screen.findByRole("heading", { name: "Requests by day, split by Workers AI vs third-party" })).toBeInTheDocument();
	});

	it("splits the chart by Workers AI vs third-party by default, and by gateway or model on request", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const legend = await screen.findByRole("list", { name: "Legend" });
		expect(legend).toHaveTextContent("Workers AI8");
		expect(legend).toHaveTextContent("Third-party2");
		await user.selectOptions(screen.getByRole("combobox", { name: "Split by" }), "gateway");
		const byGateway = screen.getByRole("list", { name: "Legend" });
		// A gateway in the legend drills into it.
		await user.click(within(byGateway).getByRole("button", { name: /^prod/ }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod" } });
	});

	it("drills into a gateway from the breakdown, carries it in the URL, and steps back out", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const breakdown = (await screen.findByRole("heading", { name: "Breakdown" })).closest("section")!;
		await user.click(await within(breakdown).findByRole("button", { name: "prod" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod" } });
		expect(location.hash).toBe("#/ai-gateway?gateway=prod");
		// The drilled-in dimension leaves the tabs; the breadcrumb names the slice.
		const tabs = screen.getByRole("tablist", { name: "Breakdown by" });
		expect(within(tabs).queryByRole("tab", { name: "Gateways" })).toBeNull();
		const crumbs = screen.getByRole("navigation", { name: "AI Gateway slice" });
		expect(crumbs).toHaveTextContent("gatewayprod");
		await user.click(within(crumbs).getByRole("button", { name: "Remove gateway filter" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: {} });
		expect(location.hash).toBe("#/ai-gateway");
	});

	it("opens a deep-linked slice, and drills further from a recent request", async () => {
		history.replaceState(null, "", "#/ai-gateway?gateway=prod");
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		expect(vi.mocked(fetchAiGatewayUsage).mock.calls[0][1]).toMatchObject({ filter: { gateway: "prod" } });
		await user.click(await screen.findByRole("button", { name: "Details" }));
		expect(screen.getByText("app/1")).toBeInTheDocument();
		const recent = screen.getByRole("heading", { name: "Recent requests" }).closest("section")!;
		await user.click(within(recent).getAllByRole("button", { name: "@cf/a" })[0]);
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod", model: "@cf/a" } });
		expect(location.hash).toBe("#/ai-gateway?gateway=prod&model=%40cf%2Fa");
	});
});

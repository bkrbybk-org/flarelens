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
	granularity: "hourly",
	timeDimension: "datetimeHour",
	series: [{ ts: "2026-11-03T10:00:00Z", requests: 10, tokens: 110, cost: 0.5, errors: 0 }],
	totals: { requests: 10, tokensIn: 100, tokensOut: 10, cost: 0.5, errors: 0, errorRate: 0, cacheHits: 2, cacheMisses: 8, cacheHitRate: 0.2, p50: 1200, p95: 5000, rateLimited: 0 },
	byGateway: [slice("prod", 7), slice("staging", 3)],
	byProvider: [slice("workers-ai", 10)],
	byModel: [slice("@cf/a", 10)],
	byStatus: [{ statusCode: "200", rateLimited: false, requests: 10 }],
	recent: [
		{ requestId: "r1", datetime: "2026-11-03T10:05:00Z", gateway: "prod", provider: "workers-ai", model: "@cf/a", statusCode: "200", durationMs: 1200, cached: false, rateLimited: false, tokensIn: 10, tokensOut: 1, cost: 0.05, userAgent: "app/1" },
	],
	previous: { requests: 5, tokens: 55, cost: 0.25, errorRate: 0, cacheHitRate: 0.6, p50: 1200 },
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

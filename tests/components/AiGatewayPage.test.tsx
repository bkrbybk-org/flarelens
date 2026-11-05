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
		user: [
			{ ts: "2026-11-03", key: "alice@example.com", requests: 6, tokens: 66, cost: 0.4, errors: 0 },
			{ ts: "2026-11-03", key: "bob@example.com", requests: 1, tokens: 11, cost: 0.05, errors: 0 },
		],
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
	byUser: [slice("alice@example.com", 6, { cost: 0.4 }), slice("bob@example.com", 1, { cost: 0.05 }), slice("(not tagged)", 3, { cost: 0.05 })],
	flows: [
		{ user: "alice@example.com", gateway: "prod", model: "@cf/meta/llama-3", requests: 5, tokens: 55, cost: 0.35 },
		{ user: "alice@example.com", gateway: "staging", model: "@cf/a", requests: 1, tokens: 11, cost: 0.05 },
		{ user: "(not tagged)", gateway: "staging", model: "@cf/a", requests: 2, tokens: 22, cost: 0.05 },
		{ user: "bob@example.com", gateway: "prod", model: "@cf/a", requests: 1, tokens: 11, cost: 0.05 },
		{ user: "(not tagged)", gateway: "prod", model: "@cf/a", requests: 1, tokens: 11, cost: 0 },
	],
	tags: {
		keys: [
			{ key: "team", requests: 8, sensitive: false },
			{ key: "user", requests: 6, sensitive: true },
		],
		selected: null,
		rows: [],
		series: [],
	},
	sessionHealth: {
		available: true,
		sessions: 4,
		basis: "all",
		flags: { abnormalCost: 1, abnormalDuration: 0, lowCacheHit: 0, highFirstContext: 0, highMcpTools: null, premiumModel: 0, thinkingModel: 0 },
	},
	recent: [
		{ requestId: "r1", datetime: "2026-11-03T10:05:00Z", gateway: "prod", provider: "workers-ai", model: "@cf/a", statusCode: "200", durationMs: 1200, cached: false, rateLimited: false, tokensIn: 10, tokensOut: 1, cost: 0.05, userAgent: "app/1", user: "alice@example.com" },
	],
	previous: { requests: 5, sessions: 2, tokens: 55, cost: 0.25, errorRate: 0, cacheHitRate: 0.6, p50: 1200 },
	previousWindow: { since: "2026-10-21T00:00:00.000Z", until: "2026-10-28T00:00:00.000Z" },
	filter: {},
	truncated: false,
	datasets: { errors: { available: true }, cache: { available: true }, spend: { available: true } },
};

/** Open one of the sections that start closed, and return it. */
async function openSection(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
	const toggle = await screen.findByRole("button", { name: title });
	if (toggle.getAttribute("aria-expanded") === "false") await user.click(toggle);
	return screen.getByRole("heading", { name: title }).closest("section")!;
}

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
		// A rate changes by points, coloured by direction: the gateway cache hit rate fell 40 points.
		const health = screen.getByRole("region", { name: "Health" });
		expect(health).toHaveTextContent("Gateway cache20.0%hit rate · ▼ 40.0 pts");
		expect(health).toHaveTextContent("Latency1.2 sp50 · p95 5.0 s");
		expect(screen.getByText("Cache hit rate fell from 60% to 20% since the previous window", { exact: false })).toBeInTheDocument();
	});

	it("opens on four headline cards and a health strip, with the detail closed below", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const card = (label: string) => screen.getByText(label, { selector: "div" }).closest("div[class*='rounded-xl']")!;
		expect(await screen.findByText("Users", { selector: "div" })).toBeInTheDocument();
		expect(card("Spend")).toHaveTextContent("$0.50");
		expect(card("Spend")).toHaveTextContent("forecast this month");
		// Two named users carry 7 of the 10 requests; "(not tagged)" is not a user.
		expect(card("Users")).toHaveTextContent("270.0% of requests name a user · 4 sessions");
		const health = screen.getByRole("region", { name: "Health" });
		expect(health).toHaveTextContent("Prompt cache28.6%40 of 140 input tokens read from the provider's cache · 50.0% of requests");
		// The chart opens on spend, so there is no separate spend line over it.
		expect(screen.getByRole("heading", { name: /^Spend by day/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Spend" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("list", { name: "Legend" })).not.toHaveTextContent("Spend (right axis)");
		// The detail starts closed: no breakdown tabs, no request rows until asked for.
		expect(screen.queryByRole("tablist", { name: "Breakdown by" })).toBeNull();
		expect(screen.getByRole("button", { name: "Recent requests" })).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("app/1")).toBeNull();
		// Activity and session health live together, one click down.
		const sessions = await openSection(user, "Session health");
		expect(sessions).toHaveTextContent("Active 1 of 7 days · $0.50 and 10 requests per active day · 4 sessions (▲ 2.0×)");
		// Clients: named, not drillable.
		const breakdown = await openSection(user, "Breakdown");
		await user.click(within(breakdown).getByRole("tab", { name: "Clients" }));
		expect(within(breakdown).getByText("opencode")).toBeInTheDocument();
		expect(within(breakdown).queryByRole("button", { name: "opencode" })).toBeNull();
		// Providers by their names, drilled by their ids.
		await user.click(within(breakdown).getByRole("tab", { name: "Providers" }));
		await user.click(within(breakdown).getByRole("button", { name: "Workers AI" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { provider: "workers-ai" } });
		expect(sessions).toHaveTextContent("4 sessions analysed by AI Gateway");
		expect(sessions).toHaveTextContent("Unusually expensive1 (25.0%)");
		// A flag the schema lacks is left out, not shown as zero.
		expect(sessions).not.toHaveTextContent("Heavy MCP tool use");
	});

	it("shows sessions instead of users on an account that tags no users", async () => {
		vi.mocked(fetchAiGatewayUsage).mockResolvedValue({ ...usage, byUser: null });
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const card = (await screen.findByText("Sessions", { selector: "div" })).closest("div[class*='rounded-xl']")!;
		expect(card).toHaveTextContent("4no user ids sent · ▲ 2.0×");
		expect(screen.queryByText("Users", { selector: "div" })).toBeNull();
		// The user donut falls back to gateways.
		expect(screen.getAllByRole("img", { name: /^Share by / })[0]).toHaveAttribute("aria-label", "Share by Gateway");
	});

	it("opens the chart on requests when nothing in the window is priced, and keeps a pick", async () => {
		vi.mocked(fetchAiGatewayUsage).mockResolvedValue({ ...usage, series: [{ ts: "2026-11-03", requests: 10, tokens: 110, cost: null, errors: 0 }] });
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		expect(await screen.findByRole("heading", { name: /^Requests by day/ })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Tokens" }));
		expect(screen.getByRole("heading", { name: /^Tokens by day/ })).toBeInTheDocument();
	});

	it("breaks spend down by a chosen tag key, and will not offer one that names people", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const breakdown = await openSection(user, "Breakdown");
		await user.click(within(breakdown).getByRole("tab", { name: "Tags" }));
		const picker = within(breakdown).getByRole("combobox", { name: "Break spend down by" });
		expect(within(picker).getByRole("option", { name: "user (6 requests) — see the Users tab" })).toBeDisabled();
		vi.mocked(fetchAiGatewayUsage).mockResolvedValue({
			...usage,
			tags: { ...usage.tags!, selected: "team", rows: [slice("search", 7), slice("(not tagged)", 3)], series: [{ ts: "2026-11-03", key: "search", requests: 7, tokens: 0, cost: 0.4, errors: 0 }] },
		});
		await user.selectOptions(picker, "team");
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ tag: "team" });
		expect(location.hash).toContain("tag=team");
		expect(await within(breakdown).findByText("search")).toBeInTheDocument();
		expect(within(breakdown).getByText("(not tagged)")).toBeInTheDocument();
		// And the chart can be split by the tag's values.
		await user.selectOptions(screen.getByRole("combobox", { name: "Group by" }), "tag");
		expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("search");
	});

	it("breaks usage down per user, groups the chart by user, and drills into one", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const breakdown = await openSection(user, "Breakdown");
		await user.click(within(breakdown).getByRole("tab", { name: "Users" }));
		expect(within(breakdown).getByRole("columnheader", { name: "User" })).toBeInTheDocument();
		expect(within(breakdown).getByRole("button", { name: "alice@example.com" })).toBeInTheDocument();
		// The remainder names nobody, so it is not a link.
		expect(within(breakdown).getByText("(not tagged)")).toBeInTheDocument();
		expect(within(breakdown).queryByRole("button", { name: "(not tagged)" })).toBeNull();
		// Group the chart by user.
		await user.selectOptions(screen.getByRole("combobox", { name: "Group by" }), "user");
		expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("alice@example.com");
		// Drill in: every figure follows, the slice is in the URL and the breadcrumb, and the Users tab goes.
		vi.mocked(fetchAiGatewayUsage).mockResolvedValue({ ...usage, filter: { user: "alice@example.com" }, byUser: [slice("alice@example.com", 6)] });
		await user.click(within(breakdown).getByRole("button", { name: "alice@example.com" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { user: "alice@example.com" } });
		expect(location.hash).toContain("user=alice%40example.com");
		const crumbs = screen.getByRole("navigation", { name: "AI Gateway slice" });
		expect(within(crumbs).getByText("alice@example.com")).toBeInTheDocument();
		expect(within(breakdown).queryByRole("tab", { name: "Users" })).toBeNull();
		// Group by user is no longer offered for a single user.
		expect(within(screen.getByRole("combobox", { name: "Group by" })).queryByRole("option", { name: "User" })).toBeNull();
	});

	it("shows a recent request's user, drillable", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const recent = await openSection(user, "Recent requests");
		await user.click(within(recent).getByRole("button", { name: "Details" }));
		await user.click(within(recent).getByRole("button", { name: "alice@example.com" }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { user: "alice@example.com" } });
	});

	it("works like a cost view: granularity, chart type, budget with overage, forecast, donuts", async () => {
		localStorage.clear();
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		await screen.findByRole("heading", { name: /^Spend by day/ });
		// The finer controls sit behind one toggle.
		expect(screen.queryByLabelText("Budget")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Chart options" }));
		// A $10/month budget against $0.50 in one day of a 7-day window: forecast $0.50/7 × 30 days.
		await user.type(screen.getByLabelText("Budget"), "10");
		expect(localStorage.getItem("flarelens_aig_budget:acc1")).toBe("10");
		expect(screen.getByText(/^On track: forecast/)).toBeInTheDocument();
		const legend = screen.getByRole("list", { name: "Legend" });
		// Per day, the budget is $10 / 30.4 ≈ $0.33, and the $0.50 day goes over it.
		expect(legend).toHaveTextContent("Budget per bucket $0.33");
		expect(document.querySelector('rect[fill="#dc2626"]')).not.toBeNull();
		// Accumulated: a running total against the budget for the whole window.
		await user.selectOptions(screen.getByRole("combobox", { name: "Granularity" }), "accumulated");
		expect(screen.getByRole("heading", { name: /^Spend, accumulated/ })).toBeInTheDocument();
		expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("Budget for the window $2.30");
		// Line chart; None gives one column per group and disables the chart type.
		await user.selectOptions(screen.getByRole("combobox", { name: "Chart" }), "line");
		expect(document.querySelector("polyline")).not.toBeNull();
		await user.selectOptions(screen.getByRole("combobox", { name: "Granularity" }), "none");
		expect(screen.getByRole("heading", { name: /^Spend for the window/ })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Chart" })).toBeDisabled();
		// 15-minute buckets do not suit a 7-day window.
		expect(within(screen.getByRole("combobox", { name: "Granularity" })).getByRole("option", { name: "15 minutes" })).toBeDisabled();
		// Donuts: share of the charted measure, the dimension picked per panel, a slice drills in.
		const donuts = screen.getAllByRole("img", { name: /^Share by / });
		// Who, what and where by default.
		expect(donuts.map((d) => d.getAttribute("aria-label"))).toEqual(["Share by User", "Share by Model", "Share by Provider"]);
		const third = donuts[2].closest("section")!;
		expect(third).toHaveTextContent("Workers AI$0.50");
		await user.selectOptions(within(third).getByRole("combobox"), "source");
		expect(third).toHaveTextContent("Workers AI");
		const first = donuts[0].closest("section")!;
		await user.click(within(first).getByRole("button", { name: /alice@example\.com/ }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { user: "alice@example.com" } });
	});

	it("shows who uses which gateway for which model, traces a node's paths, and drills from one", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const flows = (await screen.findByRole("heading", { name: "Who uses what" })).closest("section")!;
		// Sized by spend, as the chart opens on it: alice's two paths add to $0.40.
		expect(flows).toHaveTextContent("sized by spend");
		expect(within(flows).getByRole("button", { name: "User alice@example.com: $0.40. Drill in" })).toBeInTheDocument();
		// Models read without their @cf/vendor/ prefix; the untagged remainder is shown but not drillable.
		expect(within(flows).getByRole("button", { name: /^Model llama-3: \$0\.35/ })).toBeInTheDocument();
		expect(within(flows).queryByRole("button", { name: /^User \(not tagged\)/ })).toBeNull();
		expect(flows).toHaveTextContent("(not tagged) · $0.05");
		// Pointing at a model lights only the paths that reach it: alice → prod, then (alice, prod) → llama-3.
		await user.hover(within(flows).getByRole("button", { name: /^Model llama-3/ }));
		expect(flows.querySelectorAll('path[fill-opacity="0.75"]')).toHaveLength(2);
		await user.unhover(within(flows).getByRole("button", { name: /^Model llama-3/ }));
		// Errors are not carried per path: the diagram sizes by requests then.
		await user.click(screen.getByRole("button", { name: "Errors" }));
		expect(flows).toHaveTextContent("sized by requests");
		expect(within(flows).getByRole("button", { name: "User alice@example.com: 6. Drill in" })).toBeInTheDocument();
		await user.click(within(flows).getByRole("button", { name: /^Gateway prod/ }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod" } });
	});

	it("leaves the flow diagram out where the schema has no user, gateway or model to map", async () => {
		vi.mocked(fetchAiGatewayUsage).mockResolvedValue({ ...usage, flows: null });
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		await screen.findByRole("heading", { name: /^Spend by day/ });
		expect(screen.queryByRole("heading", { name: "Who uses what" })).toBeNull();
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
		expect(await screen.findByRole("heading", { name: "Spend by day, split by Workers AI vs third-party" })).toBeInTheDocument();
	});

	it("splits the chart by Workers AI vs third-party by default, and by gateway or model on request", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		await user.click(await screen.findByRole("button", { name: "Requests" }));
		const legend = screen.getByRole("list", { name: "Legend" });
		expect(legend).toHaveTextContent("Workers AI8");
		expect(legend).toHaveTextContent("Third-party2");
		await user.selectOptions(screen.getByRole("combobox", { name: "Group by" }), "gateway");
		const byGateway = screen.getByRole("list", { name: "Legend" });
		// A gateway in the legend drills into it.
		await user.click(within(byGateway).getByRole("button", { name: /^prod/ }));
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod" } });
	});

	it("drills into a gateway from the breakdown, carries it in the URL, and steps back out", async () => {
		const user = userEvent.setup();
		render(<AiGatewayPage session={session} timeRange={timeRange} onAuthError={vi.fn()} />);
		const breakdown = await openSection(user, "Breakdown");
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
		const recent = await openSection(user, "Recent requests");
		await user.click(within(recent).getByRole("button", { name: "Details" }));
		expect(screen.getByText("app/1")).toBeInTheDocument();
		await user.click(within(recent).getAllByRole("button", { name: "@cf/a" })[0]);
		expect(vi.mocked(fetchAiGatewayUsage).mock.lastCall?.[1]).toMatchObject({ filter: { gateway: "prod", model: "@cf/a" } });
		expect(location.hash).toBe("#/ai-gateway?gateway=prod&model=%40cf%2Fa");
	});
});

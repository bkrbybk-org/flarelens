import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowSankey, type FlowColumn } from "../../web/src/features/ai-gateway/FlowSankey";
import type { AiGatewayFlow } from "../../web/src/features/ai-gateway/types";
import { blockedSummary, routeNote } from "../../web/src/features/ai-gateway/GatewayConfig";
import type * as CsvModule from "../../web/src/lib/csv";

vi.mock("../../web/src/lib/csv", async (importOriginal) => {
	const actual = await importOriginal<typeof CsvModule>();
	return { ...actual, downloadBlob: vi.fn(), downloadCsv: vi.fn() };
});
import { downloadBlob } from "../../web/src/lib/csv";

const flow = (over: Partial<AiGatewayFlow>): AiGatewayFlow => ({
	user: "alice@example.com",
	gateway: "prod",
	provider: "workers-ai",
	model: "m1",
	action: "Passed",
	tag: "search",
	p95: 2000,
	requests: 1,
	tokens: 10,
	cost: 0.1,
	errors: 0,
	cached: 0,
	...over,
});

// alice: fast passed traffic on search; bob: slow, partly blocked, on chat; carol: very slow.
const FLOWS: AiGatewayFlow[] = [
	flow({ requests: 6, p95: 2000 }),
	flow({ user: "bob@example.com", tag: "chat", model: "m2", requests: 4, p95: 30_000 }),
	flow({ user: "bob@example.com", tag: "chat", model: "m2", action: "Blocked", requests: 2, cost: 0, p95: 500 }),
	flow({ user: "carol@example.com", tag: "chat", gateway: "dev", model: "m2", requests: 1, p95: 90_000 }),
];

const label = (_column: FlowColumn, key: string) => key;
const renderSankey = (props: Partial<Parameters<typeof FlowSankey>[0]> = {}) =>
	render(<FlowSankey flows={FLOWS} measure="requests" format={(v) => String(v)} label={label} tagKey="team" blockedHref="#/ai-security" onPick={vi.fn()} {...props} />);
const section = () => screen.getByRole("heading", { name: "Who uses what" }).closest("section")!;

afterEach(() => {
	vi.useRealTimers();
});

describe("FlowSankey", () => {
	it("offers the page's tag key as a column, named after the key, and never drills on it", async () => {
		const user = userEvent.setup();
		renderSankey();
		const columns = within(section()).getByRole("combobox", { name: "Columns" });
		expect([...columns.querySelectorAll("option")].map((o) => o.textContent)).toEqual(
			expect.arrayContaining(["team → user → model", "team → gateway → model → action"]),
		);
		await user.selectOptions(columns, "tag-user-model");
		const chat = within(section()).getByRole("button", { name: /^team chat: 7/ });
		await user.click(chat);
		expect(within(section()).queryByRole("button", { name: /^Drill into/ })).toBeNull();
		// The table names the column after the key too, and the CSV carries it.
		await user.click(within(section()).getByRole("button", { name: "Table" }));
		expect(within(section()).getByRole("columnheader", { name: "team" })).toBeInTheDocument();
	});

	it("colours by p95 latency, weighted by requests, in three steps", async () => {
		const user = userEvent.setup();
		renderSankey();
		await user.selectOptions(within(section()).getByRole("combobox", { name: "Colour by" }), "latency");
		const node = (name: RegExp) => within(section()).getByRole("button", { name }).querySelector("rect")!;
		// alice 2 s: green. carol 90 s: red. bob's m2 traffic: (4 × 30 s + 2 × 0.5 s + 1 × 90 s) / 7 ≈ 30 s: amber.
		expect(node(/^User alice@example\.com: 6/)).toHaveAttribute("fill", "#16a34a");
		expect(node(/^User carol@example\.com: 1/)).toHaveAttribute("fill", "#dc2626");
		expect(within(section()).getByRole("button", { name: /^Model m2: 7 · p95 ≈ 30 s/ }).querySelector("rect")).toHaveAttribute("fill", "#d97706");
		expect(within(section()).getByRole("list", { name: "Colour key" })).toHaveTextContent("p95 under 10 s10–60 s60 s or more");
	});

	it("tours the first column's busiest nodes in turn, and stops at the presenter's first pick", async () => {
		vi.useFakeTimers();
		renderSankey();
		await act(async () => {
			within(section()).getByRole("button", { name: "Tour" }).click();
			await vi.advanceTimersByTimeAsync(10);
		});
		// alice and bob tie on 6 requests: ties keep the order the data lists them in.
		expect(within(section()).getByRole("status")).toHaveTextContent("Tracing user alice@example.com");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(within(section()).getByRole("status")).toHaveTextContent("Tracing user bob@example.com");
		await act(async () => {
			within(section()).getByRole("button", { name: /^User carol@example\.com/ }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(within(section()).getByRole("button", { name: "Tour" })).toHaveAttribute("aria-pressed", "false");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(within(section()).getByRole("status")).toHaveTextContent("Tracing user carol@example.com");
	});

	it("links a trace through Blocked to the AI Security events of the same window", async () => {
		const user = userEvent.setup();
		renderSankey();
		await user.click(within(section()).getByRole("button", { name: /^Action Blocked: 2/ }));
		expect(within(section()).getByRole("link", { name: "AI Security events in this window →" })).toHaveAttribute("href", "#/ai-security");
		await user.click(within(section()).getByRole("button", { name: /^Action Passed/ }));
		expect(within(section()).queryByRole("link", { name: /AI Security/ })).toBeNull();
	});

	it("says why requests were blocked, and where a dynamic route can send one, on the trace that asks", async () => {
		const user = userEvent.setup();
		const refusals = {
			categoryNames: { P1: "Prompt Injection" },
			error: null,
			total: 13,
			read: 13,
			failed: [],
			recent: [],
			groups: [
				{ reason: "guardrails-unlogged" as const, detail: "422", side: null, count: 11, gateways: ["prod"] },
				{ reason: "guardrails" as const, detail: "P1", side: "prompt" as const, count: 2, gateways: ["prod"] },
				{ reason: "rate-limited" as const, detail: "rate_limited", side: null, count: 9, gateways: ["prod"] },
			],
		};
		const routes = [{ gateway: "prod", name: "tiers", model: "dynamic/tiers", models: ["@cf/meta/big", "@cf/meta/small"], steps: [] }];
		renderSankey({
			flows: [...FLOWS, flow({ user: "dave@example.com", model: "dynamic/tiers", action: "Blocked", requests: 3, cost: 0 })],
			blockedNote: blockedSummary(refusals),
			routeNote: (model) => routeNote(routes, model),
		});
		await user.click(within(section()).getByRole("button", { name: /^Action Blocked/ }));
		// Only blocks are reasons here; rate limits are not.
		expect(within(section()).getByRole("status")).toHaveTextContent("Why blocked: 11 category not logged, 2 Prompt Injection (P1, prompt).");
		await user.click(within(section()).getByRole("button", { name: /^Model dynamic\/tiers/ }));
		expect(within(section()).getByRole("status")).toHaveTextContent("Route tiers on prod can send to big, small; analytics records the route, not the model that answered.");
		await user.click(within(section()).getByRole("button", { name: /^Model m1/ }));
		expect(within(section()).getByRole("status")).not.toHaveTextContent("Route");
		expect(routeNote(routes, "dynamic/other")).toBeUndefined();
		expect(blockedSummary({ ...refusals, error: "The API token lacks AI Gateway: Read" })).toBeUndefined();
	});

	it("saves the diagram as a standalone SVG, with column names and no page-only attributes", async () => {
		const user = userEvent.setup();
		vi.mocked(downloadBlob).mockClear();
		// Names hidden: the label gives aliases, and nothing in the file may carry the real ones.
		const alias = (column: FlowColumn, key: string) => (column === "user" ? `User ${key[0].toUpperCase()}` : key);
		renderSankey({ label: alias });
		await user.click(within(section()).getByRole("button", { name: "Save SVG" }));
		const [name, blob] = vi.mocked(downloadBlob).mock.lastCall!;
		expect(name).toMatch(/^flarelens-who-uses-what-\d{4}-\d{2}-\d{2}\.svg$/);
		const markup = await (blob as Blob).text();
		expect(markup).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		expect(markup).toContain(">USER</text>");
		expect(markup).toContain("User A");
		expect(markup).not.toContain("@example.com");
		expect(markup).not.toMatch(/data-|role=|tabindex=/);
	});
});

import { describe, expect, it } from "vitest";
import { buildSankey, SANKEY_ROW_HEIGHT } from "../web/src/features/tunnels/sankey";
import type { MappingRow } from "../web/src/features/tunnels/types";

/**
 * The tunnel map's flow diagram is arithmetic before it is a picture, and the arithmetic is the
 * part that fails silently: a band that overflows the node it leaves, or a column whose ribbons
 * do not add up to it, still renders — it just lies about the proportions the chart exists to
 * show. These assert the sums and the geometry rather than the markup.
 */

function row(over: Partial<MappingRow> = {}): MappingRow {
	return {
		hostname: "app.example.com",
		service: "http://10.0.0.1:8080",
		originKind: "tunnel",
		tunnel: { id: "t1", name: "alpha", status: "healthy" },
		app: {
			id: "a1",
			name: "App",
			type: "self_hosted",
			policies: [{ name: "Staff", decision: "allow" }],
			policiesError: false,
		},
		...over,
	};
}

const ungated = (over: Partial<MappingRow> = {}) => row({ app: undefined, ...over });
const noTunnel = (over: Partial<MappingRow> = {}) => row({ tunnel: undefined, originKind: "worker", service: "Worker: x", ...over });

describe("buildSankey totals", () => {
	it("gives every column the same total: one ribbon row per destination", () => {
		const rows = [row(), row(), ungated(), noTunnel(), noTunnel({ originKind: "unknown", service: "—" })];
		const layout = buildSankey(rows);
		for (const column of ["gate", "tunnel", "origin"] as const) {
			const sum = layout.nodes.filter((n) => n.column === column).reduce((t, n) => t + n.value, 0);
			expect(sum, `${column} column`).toBe(rows.length);
		}
		expect(layout.total).toBe(rows.length);
	});

	it("makes every node's outgoing ribbons sum to the node itself", () => {
		const rows = [row(), row(), ungated(), ungated({ tunnel: { id: "t2", name: "beta", status: "healthy" } }), noTunnel()];
		const layout = buildSankey(rows);
		for (const node of layout.nodes.filter((n) => n.column !== "origin")) {
			const out = layout.links.filter((l) => l.source === node.id).reduce((t, l) => t + l.value, 0);
			expect(out, `out of ${node.id}`).toBe(node.value);
		}
		for (const node of layout.nodes.filter((n) => n.column !== "gate")) {
			const into = layout.links.filter((l) => l.target === node.id).reduce((t, l) => t + l.value, 0);
			expect(into, `into ${node.id}`).toBe(node.value);
		}
	});

	it("scales node height to its count, so thickness is the finding", () => {
		const rows = [row(), row(), row(), ungated()];
		const layout = buildSankey(rows);
		const gated = layout.nodes.find((n) => n.id === "gate:Gated");
		expect(gated?.height).toBe(3 * SANKEY_ROW_HEIGHT);
	});

	it("keeps every ribbon inside the node it leaves", () => {
		// A band stacked past its node's lower edge is the classic silent Sankey bug: the picture
		// still draws, and the proportions it shows are wrong.
		const rows = [row(), row(), ungated(), noTunnel(), noTunnel({ originKind: "cloudflare" })];
		const layout = buildSankey(rows);
		const stacked = new Map<string, number>();
		for (const link of layout.links) {
			stacked.set(link.source, (stacked.get(link.source) ?? 0) + link.value * SANKEY_ROW_HEIGHT);
		}
		for (const [id, used] of stacked) {
			const node = layout.nodes.find((n) => n.id === id);
			expect(used, id).toBeLessThanOrEqual(node?.height ?? 0);
		}
	});

	it("never overlaps two nodes in the same column", () => {
		const rows = [row(), ungated(), noTunnel(), noTunnel({ originKind: "unknown" }), row({ tunnel: { id: "t3", name: "gamma", status: "healthy" } })];
		const layout = buildSankey(rows);
		for (const column of ["gate", "tunnel", "origin"] as const) {
			const placed = layout.nodes.filter((n) => n.column === column).sort((a, b) => a.y - b.y);
			for (let i = 1; i < placed.length; i++) {
				expect(placed[i].y, `${column} ${placed[i].id}`).toBeGreaterThanOrEqual(placed[i - 1].y + placed[i - 1].height);
			}
		}
	});
});

describe("buildSankey meaning", () => {
	it("keeps an unidentified origin as its own node rather than folding it into the others", () => {
		// "We could not identify this origin" and "this origin needs no tunnel" are different
		// facts; merging them would report a gap as a clean result.
		const layout = buildSankey([noTunnel({ originKind: "unknown", service: "—" }), noTunnel()]);
		const unclassified = layout.nodes.find((n) => n.id === "origin:unknown");
		expect(unclassified?.label).toBe("Unclassified");
		expect(unclassified?.tone).toBe("gap");
		expect(layout.nodes.find((n) => n.id === "origin:worker")?.tone).toBe("neutral");
	});

	it("marks a tunnel serving an ungated hostname as exposed, but not one serving only a catch-all", () => {
		const exposedLayout = buildSankey([ungated({ hostname: "open.example.com" })]);
		expect(exposedLayout.nodes.find((n) => n.id === "tunnel:alpha")?.tone).toBe("exposed");

		// A catch-all rule answers 404 and fronts nothing, so it is not an exposure.
		const catchAll = buildSankey([ungated({ hostname: "(catch-all)", service: "http_status:404" })]);
		expect(catchAll.nodes.find((n) => n.id === "tunnel:alpha")?.tone).not.toBe("exposed");
	});

	it("carries a tunnel's own status onto its node", () => {
		const layout = buildSankey([row({ tunnel: { id: "t9", name: "sick", status: "down" } })]);
		const node = layout.nodes.find((n) => n.id === "tunnel:sick");
		expect(node?.tone).toBe("down");
		expect(node?.note).toBe("down");
	});

	it("offers a tunnel node as a filter and leaves the summary nodes unfiltered", () => {
		const layout = buildSankey([row(), noTunnel()]);
		expect(layout.nodes.find((n) => n.id === "tunnel:alpha")?.filter).toBe("alpha");
		// "No tunnel" is an absence, not a thing to filter the table to.
		expect(layout.nodes.find((n) => n.id === "tunnel:No tunnel")?.filter).toBe("");
		expect(layout.nodes.find((n) => n.id === "gate:Gated")?.filter).toBe("");
	});

	it("returns nothing at all for an empty map, so the caller can say why rather than draw an empty frame", () => {
		const layout = buildSankey([]);
		expect(layout.nodes).toEqual([]);
		expect(layout.links).toEqual([]);
		expect(layout.height).toBe(0);
	});
});

describe("node tone agrees with the ribbons leaving it", () => {
	it("marks the no-tunnel node as a gap when it holds an unidentified origin", () => {
		// Drawn grey, it read as "Worker or Cloudflare, no tunnel needed" — the same tone as rows
		// that are fine — while carrying every origin the dashboard could not identify.
		const withUnknown = buildSankey([noTunnel({ originKind: "unknown", service: "—" }), noTunnel()]);
		expect(withUnknown.nodes.find((n) => n.id === "tunnel:No tunnel")?.tone).toBe("gap");

		const allAccountedFor = buildSankey([noTunnel(), noTunnel({ originKind: "cloudflare" })]);
		expect(allAccountedFor.nodes.find((n) => n.id === "tunnel:No tunnel")?.tone).toBe("neutral");
	});
});

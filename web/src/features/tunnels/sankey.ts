import type { MappingRow, OriginKind } from "./types";

/**
 * Layout for the tunnel map's flow diagram: Access gate → tunnel → origin.
 *
 * Three columns, not four. An earlier draft opened with application type, but "no Access app" and
 * "ungated" are the same rows under two names — a column that restates its neighbour teaches
 * nothing. Application type stays in the table below, where a reader can sort by it.
 *
 * Every ribbon is a count of destinations, so thickness is the finding rather than decoration: on
 * a real account the two widest bands are the gated destinations that reach no tunnel, and the
 * origins nothing could classify.
 *
 * Pure geometry, no React: the arithmetic here is the part that can be wrong in a way no rendered
 * test would catch — a band that overflows its node, or a column whose links do not sum to it.
 */

/** A band is one destination tall. Everything else is derived from this. */
const ROW_HEIGHT = 10;
const NODE_WIDTH = 12;
const COLUMN_GAP_MIN = 12;
const TOP = 40;

export type SankeyColumn = "gate" | "tunnel" | "origin";

/**
 * Why a node is drawn the colour it is.
 *
 * `exposed` and `gap` are the two that mean "look at this": a destination reachable with no Access
 * policy in front of it, and a check that produced no answer. `unknown` is deliberately its own
 * tone rather than folded into `neutral` — an origin this dashboard could not identify is not the
 * same fact as an origin that legitimately involves no tunnel.
 */
export type SankeyTone = "ok" | "exposed" | "gap" | "down" | "neutral";

export interface SankeyNode {
	id: string;
	column: SankeyColumn;
	label: string;
	value: number;
	tone: SankeyTone;
	x: number;
	y: number;
	height: number;
	/** Set on tunnel nodes, so a click can filter the table to exactly this tunnel. */
	filter: string;
	/** Extra line under the label, e.g. a tunnel reporting down. */
	note?: string;
}

export interface SankeyLink {
	id: string;
	source: string;
	target: string;
	value: number;
	tone: SankeyTone;
	path: string;
}

export interface SankeyLayout {
	nodes: SankeyNode[];
	links: SankeyLink[];
	width: number;
	height: number;
	total: number;
}

const NO_TUNNEL = "No tunnel";

const ORIGIN_LABEL: Record<OriginKind, string> = {
	tunnel: "Tunnel",
	worker: "Worker",
	cloudflare: "Cloudflare",
	private: "Private network",
	unknown: "Unclassified",
};

/**
 * Origin tone. `unknown` is a gap — the dashboard could not identify what serves the hostname —
 * while a Worker or a Cloudflare-hosted page is a complete answer that simply involves no tunnel.
 */
function originTone(kind: OriginKind): SankeyTone {
	if (kind === "unknown") return "gap";
	if (kind === "tunnel") return "ok";
	return "neutral";
}

function gateOf(row: MappingRow): "Gated" | "Ungated" {
	return row.app ? "Gated" : "Ungated";
}

function tunnelOf(row: MappingRow): string {
	return row.tunnel?.name ?? NO_TUNNEL;
}

/** Stack a column's nodes top to bottom, spreading the slack between them. */
function stack(entries: { value: number }[], height: number): { y: number; height: number }[] {
	const used = entries.reduce((sum, e) => sum + e.value, 0) * ROW_HEIGHT;
	const slack = Math.max(0, height - used);
	const gap = entries.length > 1 ? Math.max(COLUMN_GAP_MIN, slack / (entries.length - 1)) : 0;
	let cursor = TOP;
	return entries.map((entry) => {
		const h = entry.value * ROW_HEIGHT;
		const placed = { y: cursor, height: h };
		cursor += h + gap;
		return placed;
	});
}

/**
 * A ribbon: a band that leaves the source at one height and arrives at the target at another.
 *
 * Drawn as two cubic curves sharing a midpoint x, so the band keeps a constant thickness at each
 * end and reads as one flow rather than two lines.
 */
function ribbon(x0: number, y0: number, x1: number, y1: number, thickness: number): string {
	const mid = (x0 + x1) / 2;
	return [
		`M${x0},${y0}`,
		`C${mid},${y0} ${mid},${y1} ${x1},${y1}`,
		`L${x1},${y1 + thickness}`,
		`C${mid},${y1 + thickness} ${mid},${y0 + thickness} ${x0},${y0 + thickness}`,
		"Z",
	].join(" ");
}

export interface SankeyOptions {
	/** Drawing width. Columns are placed against it; height follows from the row count. */
	width?: number;
}

/**
 * Build the diagram for one tunnel map.
 *
 * Returns empty rather than a zero-height drawing when there is nothing to show, so the caller can
 * render its own empty state instead of an axis with no marks.
 */
export function buildSankey(rows: MappingRow[], options: SankeyOptions = {}): SankeyLayout {
	const width = options.width ?? 1000;
	if (rows.length === 0) {
		return { nodes: [], links: [], width, height: 0, total: 0 };
	}

	// Tunnels first, biggest first, with "No tunnel" pinned to the top: it is the column's largest
	// member on most accounts and the one the reader is looking for.
	const tunnelCounts = new Map<string, number>();
	for (const row of rows) {
		const name = tunnelOf(row);
		tunnelCounts.set(name, (tunnelCounts.get(name) ?? 0) + 1);
	}
	const tunnelOrder = [...tunnelCounts.entries()]
		.sort((a, b) => {
			if (a[0] === NO_TUNNEL) return -1;
			if (b[0] === NO_TUNNEL) return 1;
			return b[1] - a[1] || a[0].localeCompare(b[0]);
		})
		.map(([name]) => name);

	const gateOrder = (["Gated", "Ungated"] as const).filter((g) => rows.some((r) => gateOf(r) === g));
	const originOrder = (Object.keys(ORIGIN_LABEL) as OriginKind[]).filter((k) => rows.some((r) => r.originKind === k));

	// Column height is set by the busiest column, so every column shares one scale.
	const tallest = Math.max(
		gateOrder.length ? rows.length : 0,
		rows.length,
	);
	const bodyHeight = tallest * ROW_HEIGHT + (Math.max(tunnelOrder.length, originOrder.length) - 1) * COLUMN_GAP_MIN;
	const height = TOP + bodyHeight + 30;

	const columnX: Record<SankeyColumn, number> = {
		gate: 90,
		tunnel: width / 2 - NODE_WIDTH / 2,
		origin: width - 120,
	};

	const nodes: SankeyNode[] = [];
	const byId = new Map<string, SankeyNode>();

	const addColumn = (
		column: SankeyColumn,
		entries: { id: string; label: string; value: number; tone: SankeyTone; filter: string; note?: string }[],
	) => {
		const placed = stack(entries, bodyHeight);
		entries.forEach((entry, i) => {
			const node: SankeyNode = {
				...entry,
				column,
				x: columnX[column],
				y: placed[i].y,
				height: placed[i].height,
			};
			nodes.push(node);
			byId.set(node.id, node);
		});
	};

	const ungatedThroughTunnel = (name: string) =>
		rows.some((r) => tunnelOf(r) === name && !r.app && r.hostname !== "(catch-all)");

	addColumn(
		"gate",
		gateOrder.map((gate) => ({
			id: `gate:${gate}`,
			label: gate,
			value: rows.filter((r) => gateOf(r) === gate).length,
			tone: gate === "Ungated" ? ("exposed" as const) : ("ok" as const),
			filter: "",
		})),
	);

	addColumn(
		"tunnel",
		tunnelOrder.map((name) => {
			const of = rows.filter((r) => tunnelOf(r) === name);
			const down = of.find((r) => r.tunnel && r.tunnel.status !== "healthy")?.tunnel?.status;
			return {
				id: `tunnel:${name}`,
				label: name,
				value: of.length,
				// A node reads as the worst thing inside it: grey on "No tunnel" understated a column
				// that holds every origin the dashboard could not identify.
				tone:
					name === NO_TUNNEL
						? of.some((r) => r.originKind === "unknown")
							? ("gap" as const)
							: ("neutral" as const)
						: down
							? ("down" as const)
							: ungatedThroughTunnel(name)
								? ("exposed" as const)
								: ("ok" as const),
				filter: name === NO_TUNNEL ? "" : name,
				note: down ?? undefined,
			};
		}),
	);

	addColumn(
		"origin",
		originOrder.map((kind) => ({
			id: `origin:${kind}`,
			label: ORIGIN_LABEL[kind],
			value: rows.filter((r) => r.originKind === kind).length,
			tone: originTone(kind),
			filter: "",
		})),
	);

	// Links, stacked in each node in the same order the nodes themselves are stacked, so ribbons
	// leaving a node do not cross each other before they have left it.
	const links: SankeyLink[] = [];
	const sourceCursor = new Map<string, number>();
	const targetCursor = new Map<string, number>();
	const cursorFor = (map: Map<string, number>, node: SankeyNode) => map.get(node.id) ?? node.y;

	const connect = (
		sourceId: string,
		targetId: string,
		value: number,
		tone: SankeyTone,
	) => {
		const source = byId.get(sourceId);
		const target = byId.get(targetId);
		if (!source || !target || value === 0) return;
		const y0 = cursorFor(sourceCursor, source);
		const y1 = cursorFor(targetCursor, target);
		const thickness = value * ROW_HEIGHT;
		links.push({
			id: `${sourceId}->${targetId}`,
			source: sourceId,
			target: targetId,
			value,
			tone,
			path: ribbon(source.x + NODE_WIDTH, y0, target.x, y1, thickness),
		});
		sourceCursor.set(source.id, y0 + thickness);
		targetCursor.set(target.id, y1 + thickness);
	};

	for (const gate of gateOrder) {
		for (const name of tunnelOrder) {
			const value = rows.filter((r) => gateOf(r) === gate && tunnelOf(r) === name).length;
			// An ungated destination that a tunnel actually serves is the exposure this page exists
			// to surface; an ungated catch-all rule serves nothing and is not.
			const exposed = gate === "Ungated" && name !== NO_TUNNEL && ungatedThroughTunnel(name);
			connect(`gate:${gate}`, `tunnel:${name}`, value, exposed ? "exposed" : gate === "Ungated" ? "neutral" : "ok");
		}
	}

	for (const name of tunnelOrder) {
		for (const kind of originOrder) {
			const value = rows.filter((r) => tunnelOf(r) === name && r.originKind === kind).length;
			connect(`tunnel:${name}`, `origin:${kind}`, value, originTone(kind));
		}
	}

	return { nodes, links, width, height, total: rows.length };
}

export const SANKEY_ROW_HEIGHT = ROW_HEIGHT;
export const SANKEY_NODE_WIDTH = NODE_WIDTH;

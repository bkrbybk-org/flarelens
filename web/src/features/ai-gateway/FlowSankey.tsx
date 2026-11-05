import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FOCUS_RING, MUTED, CARD, SECTION_TITLE, SELECT_SM } from "../../lib/ui";
import { OTHER, OTHER_COLOR, STACK_COLORS } from "./stack";
import { UNDRILLABLE, type AiGatewayFlow } from "./types";

/**
 * Who uses which gateway for which model: users on the left, gateways in the middle, models on
 * the right, each band as wide as its share of the charted measure.
 *
 * Every row is a whole user → gateway → model path, so pointing at a node lights the exact paths
 * through it — a model on the right shows which users reach it and by which gateways, not just
 * the gateways next to it. A click (or tap, or Enter) pins that trace so it holds while you talk
 * over it, with a button to drill into the node; Esc or Clear lets go.
 *
 * Bands can be coloured by user, or by the health of the path they carry — its error rate or its
 * gateway cache hit rate — so a failing user → gateway → model combination shows up red.
 */

export type FlowColumn = "user" | "gateway" | "model";
const COLUMNS: FlowColumn[] = ["user", "gateway", "model"];
const COLUMN_LABEL: Record<FlowColumn, string> = { user: "User", gateway: "Gateway", model: "Model" };

/** More nodes than this in a column fold into "Other", so the diagram stays readable. */
const TOP = 8;
const NODE_W = 12;
const GAP = 10;
/** Drawn before the card has been measured (and in tests, which have no layout). */
const FALLBACK_WIDTH = 960;

interface Node {
	key: string;
	value: number;
	y: number;
	h: number;
}

export type FlowColour = "user" | "errors" | "cache";

/** Requests, failures and cache hits behind a band or node, for its health. null: not reported. */
interface Health {
	requests: number;
	errors: number | null;
	cached: number | null;
}

const addHealth = (into: Health, from: Health) => {
	into.requests += from.requests;
	into.errors = from.errors === null ? into.errors : (into.errors ?? 0) + from.errors;
	into.cached = from.cached === null ? into.cached : (into.cached ?? 0) + from.cached;
};

/**
 * Three steps each, so a colour reads at a glance on a booth screen: errors under 1% are fine,
 * up to 5% worth a look, above that failing; a cache serving half the requests is working, a
 * tenth some, less than that hardly at all — grey rather than red, since not caching is a choice.
 */
export const HEALTH_STEPS: Record<Exclude<FlowColour, "user">, { color: string; label: string; test: (rate: number) => boolean }[]> = {
	errors: [
		{ color: "#16a34a", label: "under 1% errors", test: (r) => r < 0.01 },
		{ color: "#d97706", label: "1–5%", test: (r) => r < 0.05 },
		{ color: "#dc2626", label: "5% or more", test: () => true },
	],
	cache: [
		{ color: "#16a34a", label: "50%+ from cache", test: (r) => r >= 0.5 },
		{ color: "#2563eb", label: "10–50%", test: (r) => r >= 0.1 },
		{ color: "#a1a1aa", label: "under 10%", test: () => true },
	],
};

function healthRate(h: Health, by: Exclude<FlowColour, "user">): number | null {
	const part = by === "errors" ? h.errors : h.cached;
	return part === null || h.requests <= 0 ? null : part / h.requests;
}

function healthColor(h: Health, by: Exclude<FlowColour, "user">): string {
	const rate = healthRate(h, by);
	return rate === null ? OTHER_COLOR : HEALTH_STEPS[by].find((step) => step.test(rate))!.color;
}

const pctText = (rate: number) => `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;

/** The root font size in px: 16 normally, more in presentation mode's larger text. */
function rootPx(): number {
	const px = typeof window === "undefined" ? NaN : parseFloat(getComputedStyle(document.documentElement).fontSize);
	return Number.isFinite(px) && px > 0 ? px : 16;
}

/** The card's own width, so the diagram is drawn 1:1 in px — labels at their real size, never stretched with the card. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(FALLBACK_WIDTH);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = () => {
			const w = Math.round(el.getBoundingClientRect().width);
			if (w > 0) setWidth(w);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

/** Each column's keys, busiest first, the tail folded into "Other". */
function topKeys(flows: { path: Record<FlowColumn, string>; value: number }[], column: FlowColumn): Set<string> {
	const totals = new Map<string, number>();
	for (const f of flows) totals.set(f.path[column], (totals.get(f.path[column]) ?? 0) + f.value);
	const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
	return new Set(sorted.length <= TOP + 1 ? sorted : sorted.slice(0, TOP));
}

export function FlowSankey({
	flows,
	measure,
	format,
	label,
	onPick,
}: {
	flows: AiGatewayFlow[];
	/** Which figure sizes the bands. */
	measure: "requests" | "tokens" | "cost" | "errors";
	format: (value: number) => string;
	label: (column: FlowColumn, key: string) => string;
	onPick?: (column: FlowColumn, key: string) => void;
}) {
	// What the pointer is over, and what a click pinned; a pin outlasts the pointer leaving.
	const [hovered, setHovered] = useState<{ column: FlowColumn; key: string } | null>(null);
	const [pinned, setPinned] = useState<{ column: FlowColumn; key: string } | null>(null);
	const [colourBy, setColourBy] = useState<FlowColour>("user");
	const [boxRef, W] = useWidth();
	// Geometry in real px. Labels are 0.75rem; each side keeps room for one, up to 17rem or 30% of
	// the width, and a label longer than its room is cut with an ellipsis (full name on hover).
	const font = 0.75 * rootPx();
	const LABEL_ROOM = Math.min(17 * rootPx(), W * 0.3);
	const X: Record<FlowColumn, number> = { user: LABEL_ROOM, gateway: (W - NODE_W) / 2, model: W - LABEL_ROOM - NODE_W };
	// Room for a label in px: either margin for users and models, the gap up to the model column for
	// gateways. The name is cut to what fits beside its value, which is never cut.
	const room: Record<FlowColumn, number> = { user: LABEL_ROOM - 10, gateway: X.model - X.gateway - NODE_W - 14, model: LABEL_ROOM - 10 };
	// In a narrow card names matter more than figures: the value moves to the tooltip.
	const showValues = W >= 640;
	const fit = (column: FlowColumn, name: string, value: string) => {
		const suffix = showValues ? ` · ${value}` : "";
		const chars = Math.max(4, Math.floor(room[column] / (font * 0.6)) - suffix.length);
		return `${name.length > chars ? `${name.slice(0, chars - 1)}…` : name}${suffix}`;
	};
	// A node is never given less height than a line of its label, so neighbours' labels cannot overlap.
	const SLOT = Math.ceil(font * 1.5);

	// Health colours are offered only for what the schema reports per path.
	const colourOptions: { id: FlowColour; label: string }[] = [
		{ id: "user", label: "User" },
		...(flows.some((f) => f.errors !== null) ? [{ id: "errors" as const, label: "Error rate" }] : []),
		...(flows.some((f) => f.cached !== null) ? [{ id: "cache" as const, label: "Cache hit rate" }] : []),
	];
	const colour: FlowColour = colourOptions.some((o) => o.id === colourBy) ? colourBy : "user";

	const valued = flows
		.map((f) => ({
			path: { user: f.user, gateway: f.gateway, model: f.model },
			value: (measure === "cost" ? f.cost : measure === "tokens" ? f.tokens : measure === "errors" ? f.errors : f.requests) ?? 0,
			health: { requests: f.requests, errors: f.errors, cached: f.cached } as Health,
		}))
		.filter((f) => f.value > 0);
	const kept = Object.fromEntries(COLUMNS.map((c) => [c, topKeys(valued, c)])) as Record<FlowColumn, Set<string>>;
	const paths = valued.map((f) => ({
		value: f.value,
		health: f.health,
		path: Object.fromEntries(COLUMNS.map((c) => [c, kept[c].has(f.path[c]) ? f.path[c] : OTHER])) as Record<FlowColumn, string>,
	}));
	const total = paths.reduce((n, p) => n + p.value, 0);
	const measureName = measure === "cost" ? "spend" : measure;

	if (!total) {
		return (
			<section className={CARD} aria-labelledby="aig-flows-title">
				<h2 id="aig-flows-title" className={SECTION_TITLE}>Who uses what</h2>
				<p className={`py-8 text-center text-sm ${MUTED}`}>No user → gateway → model {measureName} to show in this window.</p>
			</section>
		);
	}

	// Node order and size per column; every column sums to the same total, so one scale fits all.
	const keysOf = (column: FlowColumn) => {
		const sums = new Map<string, number>();
		for (const p of paths) sums.set(p.path[column], (sums.get(p.path[column]) ?? 0) + p.value);
		// "Other" and the untagged remainder sit last, whatever their size.
		const last = (key: string) => key === OTHER || UNDRILLABLE.has(key);
		return [...sums.entries()].sort((a, b) => Number(last(a[0])) - Number(last(b[0])) || b[1] - a[1]);
	};
	const sorted = Object.fromEntries(COLUMNS.map((c) => [c, keysOf(c)])) as Record<FlowColumn, [string, number][]>;
	const most = Math.max(...COLUMNS.map((c) => sorted[c].length));
	// Bands share one scale; the plot is as tall as the busiest column needs, at least 14rem.
	const target = Math.max(14 * rootPx(), most * (SLOT + GAP) * 1.6);
	const scale = Math.min(...COLUMNS.map((c) => (target - GAP * (sorted[c].length - 1)) / total));
	const advance = (value: number) => Math.max(value * scale, SLOT) + GAP;
	const extent = (c: FlowColumn) => sorted[c].reduce((n, [, v]) => n + advance(v), 0) - GAP;
	const H = Math.ceil(Math.max(...COLUMNS.map(extent)));
	const nodes = Object.fromEntries(
		COLUMNS.map((c) => {
			// Centre a shorter column vertically against the tallest; a node below a line's height
			// keeps its true thickness but takes a line's room.
			let y = (H - extent(c)) / 2;
			const list = sorted[c].map(([key, value]) => {
				const h = Math.max(1, value * scale);
				const room = Math.max(h, SLOT);
				const node: Node = { key, value, y: y + (room - h) / 2, h };
				y += room + GAP;
				return node;
			});
			return [c, new Map(list.map((n) => [n.key, n]))];
		}),
	) as Record<FlowColumn, Map<string, Node>>;
	const order = (column: FlowColumn, key: string) => [...nodes[column].keys()].indexOf(key);
	const userColor = (key: string) => (key === OTHER || UNDRILLABLE.has(key) ? OTHER_COLOR : STACK_COLORS[order("user", key) % STACK_COLORS.length]);
	// Health per node, summed over the paths through it.
	const nodeHealth = (column: FlowColumn, key: string) => {
		const h: Health = { requests: 0, errors: null, cached: null };
		for (const p of paths) if (p.path[column] === key) addHealth(h, p.health);
		return h;
	};
	const healthNote = (h: Health) => {
		if (colour === "user") return "";
		const rate = healthRate(h, colour);
		return rate === null ? "" : ` · ${pctText(rate)} ${colour === "errors" ? "errors" : "from cache"}`;
	};

	// A pin on a node no longer drawn (another window, another measure) is simply not shown.
	const shown = (n: { column: FlowColumn; key: string } | null) => (n && nodes[n.column].has(n.key) ? n : null);
	const pin = shown(pinned);
	const active = pin ?? shown(hovered);

	// The two link stages, aggregated, each band keyed by its user so it carries the user's colour
	// across the gateway: user → gateway, then (user, gateway) → model.
	const stage = (from: FlowColumn, to: FlowColumn) => {
		const bands = new Map<string, { user: string; from: string; to: string; value: number; lit: number; health: Health }>();
		const through = (p: (typeof paths)[number]) => !active || p.path[active.column] === active.key;
		for (const p of paths) {
			const id = JSON.stringify([p.path.user, p.path[from], p.path[to]]);
			const band = bands.get(id) ?? { user: p.path.user, from: p.path[from], to: p.path[to], value: 0, lit: 0, health: { requests: 0, errors: null, cached: null } };
			band.value += p.value;
			addHealth(band.health, p.health);
			if (through(p)) band.lit += p.value;
			bands.set(id, band);
		}
		// Stack bands at each end in the order of the node at the other end, so they cross least.
		const list = [...bands.values()];
		const outOffset = new Map<string, number>();
		const inOffset = new Map<string, number>();
		const placed = list
			.map((b) => ({ ...b }))
			.sort((a, b) => order(to, a.to) - order(to, b.to) || order("user", a.user) - order("user", b.user))
			.map((b) => {
				const offset = outOffset.get(b.from) ?? 0;
				outOffset.set(b.from, offset + b.value * scale);
				return { ...b, y0: nodes[from].get(b.from)!.y + offset };
			})
			.sort((a, b) => order(from, a.from) - order(from, b.from) || order("user", a.user) - order("user", b.user))
			.map((b) => {
				const offset = inOffset.get(b.to) ?? 0;
				inOffset.set(b.to, offset + b.value * scale);
				return { ...b, y1: nodes[to].get(b.to)!.y + offset };
			});
		return placed.map((b) => ({ ...b, fromColumn: from, toColumn: to, x0: X[from] + NODE_W, x1: X[to] }));
	};
	const bands = [...stage("user", "gateway"), ...stage("gateway", "model")];
	const bandColor = (b: (typeof bands)[number]) => (colour === "user" ? userColor(b.user) : healthColor(b.health, colour));
	const ribbon = (x0: number, y0: number, x1: number, y1: number, h: number) => {
		const mid = (x0 + x1) / 2;
		return `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z`;
	};
	const drillable = (key: string) => Boolean(onPick) && key !== OTHER && !UNDRILLABLE.has(key);
	const counts = COLUMNS.map((c) => `${nodes[c].size} ${COLUMN_LABEL[c].toLowerCase()}${nodes[c].size === 1 ? "" : "s"}`).join(", ");
	const toggle = (column: FlowColumn, key: string) => setPinned((now) => (now && now.column === column && now.key === key ? null : { column, key }));

	return (
		<section
			className={CARD}
			aria-labelledby="aig-flows-title"
			onKeyDown={(e) => {
				if (e.key === "Escape" && pinned) {
					e.stopPropagation();
					setPinned(null);
				}
			}}
		>
			<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 id="aig-flows-title" className={SECTION_TITLE}>Who uses what</h2>
				<span className={`text-xs ${MUTED}`}>User → gateway → model, sized by {measureName}. Point at or tap one to trace its paths.</span>
				{colourOptions.length > 1 && (
					<label className="ml-auto flex items-center gap-1.5 text-xs">
						<span className={MUTED}>Colour by</span>
						<select value={colour} onChange={(e) => setColourBy(e.target.value as FlowColour)} className={SELECT_SM}>
							{colourOptions.map((o) => (
								<option key={o.id} value={o.id}>{o.label}</option>
							))}
						</select>
					</label>
				)}
			</div>
			{pin && (
				<div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-950/40" role="status">
					<span>
						<span className={MUTED}>Tracing {COLUMN_LABEL[pin.column].toLowerCase()} </span>
						<span className="font-medium">{label(pin.column, pin.key)}</span>
						<span className={MUTED}>
							{" "}· {format(nodes[pin.column].get(pin.key)!.value)}
							{healthNote(nodeHealth(pin.column, pin.key))}
						</span>
					</span>
					<span className="ml-auto flex gap-2">
						{drillable(pin.key) && (
							<button type="button" onClick={() => onPick!(pin.column, pin.key)} className={`rounded-md bg-cf px-2.5 py-1 font-medium text-white hover:opacity-90 ${FOCUS_RING}`}>
								Drill into {label(pin.column, pin.key)}
							</button>
						)}
						<button type="button" onClick={() => setPinned(null)} className={`rounded-md border border-zinc-200 px-2.5 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`}>
							Clear <kbd className="font-mono text-[10px] text-zinc-400">Esc</kbd>
						</button>
					</span>
				</div>
			)}
			<div className={`mb-1 grid grid-cols-3 text-xs font-medium uppercase tracking-wide ${MUTED}`} aria-hidden>
				<span>User</span>
				<span className="text-center">Gateway</span>
				<span className="text-right">Model</span>
			</div>
			<div ref={boxRef}>
			<svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" role="group" aria-label={`Flows from users to gateways to models: ${counts}`} onMouseLeave={() => setHovered(null)}>
				<g>
					{bands.map((b, i) => (
						<path
							key={`base-${i}`}
							d={ribbon(b.x0, b.y0, b.x1, b.y1, Math.max(0.5, b.value * scale))}
							fill={bandColor(b)}
							fillOpacity={active ? 0.08 : colour === "user" ? 0.35 : 0.55}
							data-band={`${b.fromColumn}:${b.from}>${b.toColumn}:${b.to}`}
						>
							<title>{`${label(b.fromColumn, b.from)} → ${label(b.toColumn, b.to)}: ${format(b.value)}${healthNote(b.health)}`}</title>
						</path>
					))}
					{/* The paths through the node traced, drawn over their bands at the same place. */}
					{active &&
						bands
							.filter((b) => b.lit > 0)
							.map((b, i) => <path key={`lit-${i}`} d={ribbon(b.x0, b.y0, b.x1, b.y1, Math.max(0.5, b.lit * scale))} fill={bandColor(b)} fillOpacity={0.75} pointerEvents="none" data-lit />)}
				</g>
				{COLUMNS.map((column) =>
					[...nodes[column].values()].map((node) => {
						const text = fit(column, label(column, node.key), format(node.value));
						const health = nodeHealth(column, node.key);
						const fill = colour !== "user" ? healthColor(health, colour) : column === "user" ? userColor(node.key) : node.key === OTHER ? OTHER_COLOR : "#71717a";
						const isPinned = Boolean(pin && pin.column === column && pin.key === node.key);
						const isActive = Boolean(active && active.column === column && active.key === node.key);
						// The node and its label, so a thin node is still easy to point at.
						const hit = column === "user" ? { x: 0, w: X.user + NODE_W } : column === "model" ? { x: X.model, w: W - X.model } : { x: X.gateway, w: LABEL_ROOM };
						const labelX = column === "user" ? X.user - 8 : column === "model" ? X.model + NODE_W + 8 : X.gateway + NODE_W + 6;
						const anchor = column === "user" ? "end" : "start";
						return (
							<g
								key={`${column}-${node.key}`}
								role="button"
								tabIndex={0}
								aria-pressed={isPinned}
								aria-label={`${COLUMN_LABEL[column]} ${label(column, node.key)}: ${format(node.value)}${healthNote(health)}. ${isPinned ? "Tracing; select again to stop" : "Select to trace its paths"}`}
								className={`cursor-pointer outline-none ${FOCUS_RING}`}
								onMouseEnter={() => setHovered({ column, key: node.key })}
								onFocus={() => setHovered({ column, key: node.key })}
								onBlur={() => setHovered(null)}
								onClick={() => toggle(column, node.key)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										toggle(column, node.key);
									}
								}}
							>
								<title>{`${label(column, node.key)}: ${format(node.value)} (${Math.round((node.value / total) * 100)}%)${healthNote(health)}`}</title>
								<rect
									x={X[column]}
									y={node.y}
									width={NODE_W}
									height={node.h}
									rx={2}
									fill={fill}
									className={isPinned ? "stroke-zinc-900 dark:stroke-white" : undefined}
									strokeWidth={isPinned ? 2 : 0}
								/>
								<rect x={hit.x} y={node.y + node.h / 2 - Math.max(node.h, SLOT) / 2} width={hit.w} height={Math.max(node.h, SLOT)} fill="transparent" />
								<text
									x={labelX}
									y={node.y + node.h / 2}
									dominantBaseline="middle"
									textAnchor={anchor}
									className={`text-[0.75rem] ${isActive ? "font-semibold" : ""} fill-zinc-700 stroke-white dark:fill-zinc-200 dark:stroke-zinc-900`}
									strokeWidth={3}
									paintOrder="stroke"
								>
									{text}
								</text>
							</g>
						);
					}),
				)}
			</svg>
			</div>
			{colour !== "user" && (
				<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Colour key">
					{HEALTH_STEPS[colour].map((step) => (
						<li key={step.label} className="flex items-center gap-1.5">
							<span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: step.color }} />
							{step.label}
						</li>
					))}
					<li className={`flex items-center gap-1.5 ${MUTED}`}>
						<span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OTHER_COLOR }} />
						not reported
					</li>
				</ul>
			)}
		</section>
	);
}

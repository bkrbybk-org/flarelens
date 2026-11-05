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
 * the gateways next to it. A band traces the same way: the paths along that one segment. A click
 * (or tap, or Enter) pins the trace so it holds while you talk over it, with a button to drill
 * into what it names — one filter for a node, two or three at once for a band; Esc or Clear lets go.
 *
 * Bands can be coloured by user, or by the health of the path they carry — its error rate or its
 * gateway cache hit rate — so a failing user → gateway → model combination shows up red. Against
 * the window before, a path seen for the first time is outlined, and new and quiet paths are listed.
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

/** What is traced: a node, or one band — a user's traffic along one segment between two columns. */
type Selection = { kind: "node"; column: FlowColumn; key: string } | { kind: "band"; user: string; fromColumn: FlowColumn; from: string; toColumn: FlowColumn; to: string };
/** The filters a drill applies: one for a node, up to all three for a band. */
export type FlowDrill = Partial<Record<FlowColumn, string>>;

const sameSelection = (a: Selection | null, b: Selection | null) => JSON.stringify(a) === JSON.stringify(b);
const pathKey = (f: { user: string; gateway: string; model: string }) => JSON.stringify([f.user, f.gateway, f.model]);
/** How many new or quiet paths are listed before "and N more". */
const CHANGES_SHOWN = 4;

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
	previousFlows,
	measure,
	format,
	label,
	onPick,
}: {
	flows: AiGatewayFlow[];
	/** The same paths over the window before; new and quiet paths are told from these. */
	previousFlows?: AiGatewayFlow[] | null;
	/** Which figure sizes the bands. */
	measure: "requests" | "tokens" | "cost" | "errors";
	format: (value: number) => string;
	label: (column: FlowColumn, key: string) => string;
	onPick?: (drill: FlowDrill) => void;
}) {
	// What the pointer is over, and what a click pinned; a pin outlasts the pointer leaving.
	const [hovered, setHovered] = useState<Selection | null>(null);
	const [pinned, setPinned] = useState<Selection | null>(null);
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
	const valueOf = (f: AiGatewayFlow) => (measure === "cost" ? f.cost : measure === "tokens" ? f.tokens : measure === "errors" ? f.errors : f.requests) ?? 0;

	// Against the window before. Said only when that window had traffic to compare with — against
	// an empty one every path would read as new.
	const before = previousFlows?.length ? new Set(previousFlows.map(pathKey)) : null;
	const nowSeen = new Set(flows.map(pathKey));
	const newPaths = before ? flows.filter((f) => !before.has(pathKey(f)) && valueOf(f) > 0).sort((a, b) => valueOf(b) - valueOf(a)) : [];
	const quietPaths = before ? previousFlows!.filter((f) => !nowSeen.has(pathKey(f)) && valueOf(f) > 0).sort((a, b) => valueOf(b) - valueOf(a)) : [];
	// An outline marks the exception. When most paths are new (tagging only just started, say),
	// outlining most of the diagram would mark nothing, so the list says so instead.
	const outlineNew = Boolean(before) && newPaths.length * 2 <= flows.filter((f) => valueOf(f) > 0).length;
	// A band is new when no path of the window before ran along the same user and segment.
	const seenSegments = new Set(
		(previousFlows ?? []).flatMap((f) => [JSON.stringify([f.user, "user", f.user, "gateway", f.gateway]), JSON.stringify([f.user, "gateway", f.gateway, "model", f.model])]),
	);

	const valued = flows
		.map((f) => ({
			path: { user: f.user, gateway: f.gateway, model: f.model },
			value: valueOf(f),
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
	const pathText = (f: AiGatewayFlow) => `${label("user", f.user)} → ${label("gateway", f.gateway)} → ${label("model", f.model)}`;

	const changes =
		before && (newPaths.length > 0 || quietPaths.length > 0) ? (
			<div className="mt-3 grid gap-3 border-t border-zinc-100 pt-3 text-xs sm:grid-cols-2 dark:border-zinc-800" aria-label="Since the previous window">
				{(
					[
						["New this window", newPaths, outlineNew ? "Outlined in the diagram." : "Most paths are new, so the diagram does not outline them."],
						["Gone quiet", quietPaths, `${measureName === "spend" ? "Spend" : measureName[0].toUpperCase() + measureName.slice(1)} in the window before.`],
					] as const
				).map(([title, list, note]) => (
					<section key={title} aria-label={title}>
						<h3 className="mb-1 font-semibold">
							{title} <span className={`font-normal ${MUTED}`}>· {list.length} {list.length === 1 ? "path" : "paths"}</span>
						</h3>
						{list.length ? (
							<>
								<ul className="space-y-0.5">
									{list.slice(0, CHANGES_SHOWN).map((f) => (
										<li key={pathKey(f)} className="flex gap-2">
											<span className="min-w-0 flex-1 truncate" title={`${f.user} → ${f.gateway} → ${f.model}`}>
												{pathText(f)}
											</span>
											<span className="shrink-0 tabular-nums">{format(valueOf(f))}</span>
										</li>
									))}
								</ul>
								<p className={`mt-1 ${MUTED}`}>
									{list.length > CHANGES_SHOWN ? `and ${list.length - CHANGES_SHOWN} more. ` : ""}
									{note}
								</p>
							</>
						) : (
							<p className={MUTED}>None.</p>
						)}
					</section>
				))}
			</div>
		) : null;

	if (!total) {
		return (
			<section className={CARD} aria-labelledby="aig-flows-title">
				<h2 id="aig-flows-title" className={SECTION_TITLE}>Who uses what</h2>
				<p className={`py-8 text-center text-sm ${MUTED}`}>No user → gateway → model {measureName} to show in this window.</p>
				{changes}
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

	// Whether a path runs through what is traced.
	const through = (sel: Selection, p: (typeof paths)[number]) =>
		sel.kind === "node" ? p.path[sel.column] === sel.key : p.path.user === sel.user && p.path[sel.fromColumn] === sel.from && p.path[sel.toColumn] === sel.to;

	// The two link stages, aggregated, each band keyed by its user so it carries the user's colour
	// across the gateway: user → gateway, then (user, gateway) → model.
	const stage = (from: FlowColumn, to: FlowColumn, active: Selection | null) => {
		const bands = new Map<string, { user: string; from: string; to: string; value: number; lit: number; health: Health }>();
		for (const p of paths) {
			const id = JSON.stringify([p.path.user, p.path[from], p.path[to]]);
			const band = bands.get(id) ?? { user: p.path.user, from: p.path[from], to: p.path[to], value: 0, lit: 0, health: { requests: 0, errors: null, cached: null } };
			band.value += p.value;
			addHealth(band.health, p.health);
			if (!active || through(active, p)) band.lit += p.value;
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
		return placed.map((b) => {
			const selection: Selection = { kind: "band", user: b.user, fromColumn: from, from: b.from, toColumn: to, to: b.to };
			const folded = b.user === OTHER || b.from === OTHER || b.to === OTHER;
			const isNew = outlineNew && !folded && !seenSegments.has(JSON.stringify([b.user, from, b.from, to, b.to]));
			return { ...b, selection, isNew, fromColumn: from, toColumn: to, x0: X[from] + NODE_W, x1: X[to] };
		});
	};

	// A pin on something no longer drawn (another window, another measure) is simply not shown.
	const drawnBands = [...stage("user", "gateway", null), ...stage("gateway", "model", null)];
	const shown = (sel: Selection | null): Selection | null =>
		!sel ? null : sel.kind === "node" ? (nodes[sel.column].has(sel.key) ? sel : null) : drawnBands.some((b) => sameSelection(b.selection, sel)) ? sel : null;
	const pin = shown(pinned);
	const active = pin ?? shown(hovered);
	const bands = active ? [...stage("user", "gateway", active), ...stage("gateway", "model", active)] : drawnBands;

	const bandColor = (b: (typeof bands)[number]) => (colour === "user" ? userColor(b.user) : healthColor(b.health, colour));
	const ribbon = (x0: number, y0: number, x1: number, y1: number, h: number) => {
		const mid = (x0 + x1) / 2;
		return `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z`;
	};
	const drillable = (key: string) => key !== OTHER && !UNDRILLABLE.has(key);
	const counts = COLUMNS.map((c) => `${nodes[c].size} ${COLUMN_LABEL[c].toLowerCase()}${nodes[c].size === 1 ? "" : "s"}`).join(", ");
	const toggle = (sel: Selection) => setPinned((now) => (sameSelection(now, sel) ? null : sel));
	const pressKeys = (sel: Selection) => (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle(sel);
		}
	};

	// What a selection says and drills into. A band carries its user, so its drill is the user (when
	// drillable) plus both ends; anything folded or untagged is left out of the filter.
	const describe = (sel: Selection) => {
		if (sel.kind === "node") {
			const node = nodes[sel.column].get(sel.key)!;
			return {
				title: `${COLUMN_LABEL[sel.column].toLowerCase()} ${label(sel.column, sel.key)}`,
				value: node.value,
				health: nodeHealth(sel.column, sel.key),
				drill: drillable(sel.key) ? ({ [sel.column]: sel.key } as FlowDrill) : {},
			};
		}
		const band = drawnBands.find((b) => sameSelection(b.selection, sel))!;
		const drill: FlowDrill = {};
		for (const [column, key] of [["user", sel.user], [sel.fromColumn, sel.from], [sel.toColumn, sel.to]] as [FlowColumn, string][]) if (drillable(key)) drill[column] = key;
		const ends = `${label(sel.fromColumn, sel.from)} → ${label(sel.toColumn, sel.to)}`;
		return { title: sel.fromColumn === "user" ? ends : `${label("user", sel.user)}: ${ends}`, value: band.value, health: band.health, drill };
	};
	const pinInfo = pin ? describe(pin) : null;
	const drillParts = pinInfo ? (COLUMNS.filter((c) => pinInfo.drill[c]) as FlowColumn[]) : [];

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
				<span className={`text-xs ${MUTED}`}>User → gateway → model, sized by {measureName}. Point at or tap a node or band to trace it.</span>
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
			{pin && pinInfo && (
				<div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-950/40" role="status">
					<span>
						<span className={MUTED}>Tracing </span>
						<span className="font-medium">{pinInfo.title}</span>
						<span className={MUTED}>
							{" "}· {format(pinInfo.value)}
							{healthNote(pinInfo.health)}
						</span>
					</span>
					<span className="ml-auto flex gap-2">
						{onPick && drillParts.length > 0 && (
							<button type="button" onClick={() => onPick(pinInfo.drill)} className={`rounded-md bg-cf px-2.5 py-1 font-medium text-white hover:opacity-90 ${FOCUS_RING}`}>
								Drill into {drillParts.map((c) => label(c, pinInfo.drill[c]!)).join(" · ")}
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
					{bands.map((b) => {
						const isPinned = sameSelection(pin, b.selection);
						const name = `${b.fromColumn === "user" ? "" : `${label("user", b.user)}: `}${label(b.fromColumn, b.from)} → ${label(b.toColumn, b.to)}`;
						return (
							<path
								key={JSON.stringify(b.selection)}
								d={ribbon(b.x0, b.y0, b.x1, b.y1, Math.max(0.5, b.value * scale))}
								fill={bandColor(b)}
								fillOpacity={active ? 0.08 : colour === "user" ? 0.35 : 0.55}
								stroke={isPinned ? "currentColor" : b.isNew ? bandColor(b) : "none"}
								strokeWidth={isPinned ? 1.5 : b.isNew ? 1.5 : 0}
								strokeDasharray={!isPinned && b.isNew ? "5 3" : undefined}
								className={`cursor-pointer outline-none ${isPinned ? "text-zinc-900 dark:text-white" : ""} ${FOCUS_RING}`}
								data-band={`${b.fromColumn}:${b.from}>${b.toColumn}:${b.to}`}
								data-new={b.isNew || undefined}
								role="button"
								tabIndex={0}
								aria-pressed={isPinned}
								aria-label={`${name}: ${format(b.value)}${healthNote(b.health)}${b.isNew ? ", new this window" : ""}. ${isPinned ? "Tracing; select again to stop" : "Select to trace"}`}
								onMouseEnter={() => setHovered(b.selection)}
								onFocus={() => setHovered(b.selection)}
								onBlur={() => setHovered(null)}
								onClick={() => toggle(b.selection)}
								onKeyDown={pressKeys(b.selection)}
							>
								<title>{`${name}: ${format(b.value)}${healthNote(b.health)}${b.isNew ? " · new this window" : ""}`}</title>
							</path>
						);
					})}
					{/* The paths along what is traced, drawn over their bands at the same place. */}
					{active &&
						bands
							.filter((b) => b.lit > 0)
							.map((b) => (
								<path key={`lit-${JSON.stringify(b.selection)}`} d={ribbon(b.x0, b.y0, b.x1, b.y1, Math.max(0.5, b.lit * scale))} fill={bandColor(b)} fillOpacity={0.75} pointerEvents="none" data-lit />
							))}
				</g>
				{COLUMNS.map((column) =>
					[...nodes[column].values()].map((node) => {
						const sel: Selection = { kind: "node", column, key: node.key };
						const text = fit(column, label(column, node.key), format(node.value));
						const health = nodeHealth(column, node.key);
						const fill = colour !== "user" ? healthColor(health, colour) : column === "user" ? userColor(node.key) : node.key === OTHER ? OTHER_COLOR : "#71717a";
						const isPinned = sameSelection(pin, sel);
						const isActive = sameSelection(active, sel);
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
								onMouseEnter={() => setHovered(sel)}
								onFocus={() => setHovered(sel)}
								onBlur={() => setHovered(null)}
								onClick={() => toggle(sel)}
								onKeyDown={pressKeys(sel)}
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
									className={`text-[0.75rem] ${isActive ? "font-semibold" : ""} pointer-events-none fill-zinc-700 stroke-white dark:fill-zinc-200 dark:stroke-zinc-900`}
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
			{(colour !== "user" || drawnBands.some((b) => b.isNew)) && (
				<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Colour key">
					{colour !== "user" && (
						<>
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
						</>
					)}
					{drawnBands.some((b) => b.isNew) && (
						<li className="flex items-center gap-1.5">
							<span aria-hidden className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-zinc-500" />
							new this window
						</li>
					)}
				</ul>
			)}
			{changes}
		</section>
	);
}

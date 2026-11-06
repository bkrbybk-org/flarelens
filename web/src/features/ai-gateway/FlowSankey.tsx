import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FOCUS_RING, MUTED, CARD, SECTION_TITLE, SELECT_SM } from "../../lib/ui";
import { downloadBlob, downloadCsv, toCsv } from "../../lib/csv";
import { ACTION_COLORS, OTHER, OTHER_COLOR, STACK_COLORS } from "./stack";
import { UNDRILLABLE, compactCount, formatCost, type AiGatewayFlow } from "./types";

/**
 * Who uses which gateway for which model: by default users on the left, gateways in the middle,
 * models on the right, each band as wide as its share of the charted measure (requests, with the
 * action column, unless *Size by* says otherwise). The columns can be
 * reordered to start from the model, or widened with the provider between gateway and model.
 *
 * Every row is a whole path, so pointing at a node lights the exact paths through it — a model on
 * the right shows which users reach it and by which gateways, not just the gateways next to it. A
 * band traces the same way: the paths along that one segment. A click (or tap, or Enter) pins the
 * trace so it holds while you talk over it, with a button to drill into what it names — one filter
 * for a node, two or three at once for a band; Esc or Clear lets go.
 *
 * Bands are coloured by one column (the user, by default), and each band carries that column's key
 * the whole way across, so a colour can be followed from end to end. They can instead be coloured
 * by the health of the path they carry — its error rate or its gateway cache hit rate — so a
 * failing combination shows up red. Against the window before, a path seen for the first time is
 * outlined, and new and quiet paths are listed.
 *
 * For a screen across a room, the three biggest bands carry their figure, and paths under 1% or 5%
 * can be left out. A table lists every path with all its figures, and exports as CSV.
 */

export type FlowColumn = "user" | "gateway" | "provider" | "model" | "action" | "tag";
/** Column names; the tag column is named after the page's tag key (team, cost center…) where one is picked. */
const COLUMN_LABEL: Record<FlowColumn, string> = { user: "User", gateway: "Gateway", provider: "Provider", model: "Model", action: "Action", tag: "Tag" };

/**
 * The column orders on offer, the first available being the default; one with the provider or the
 * action only where the schema reports it. The action is what AI Gateway did with the requests —
 * passed them on, answered from cache, blocked, rate limited — told from each request's status.
 */
export const FLOW_LAYOUTS: { id: string; columns: FlowColumn[] }[] = [
	{ id: "user-gateway-model-action", columns: ["user", "gateway", "model", "action"] },
	{ id: "user-gateway-model", columns: ["user", "gateway", "model"] },
	{ id: "user-gateway-provider-model", columns: ["user", "gateway", "provider", "model"] },
	{ id: "user-gateway-action", columns: ["user", "gateway", "action"] },
	{ id: "model-gateway-user", columns: ["model", "gateway", "user"] },
	// With a tag key picked on the page (team, cost center…): chargeback by tag rather than by person.
	{ id: "tag-user-model", columns: ["tag", "user", "model"] },
	{ id: "tag-gateway-model-action", columns: ["tag", "gateway", "model", "action"] },
];


/** Paths smaller than this share of the measure can be left out, to cut clutter on a big screen. */
const CUTOFFS = [
	{ share: 0, label: "All paths" },
	{ share: 0.01, label: "Hide under 1%" },
	{ share: 0.05, label: "Hide under 5%" },
];
/** How many of the biggest bands carry their figure. */
const FIGURES = 3;
/** How many of the names folded into "Other" are spelled out before "and N more". */
const OTHER_NAMED = 8;
/** The tour: how many of the first column's busiest nodes it traces, and how long it holds each. */
const TOUR_STOPS = 6;
const TOUR_MS = 5000;

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

type Path = Record<FlowColumn, string>;
const pathOf = (f: AiGatewayFlow): Path => ({
	user: f.user,
	gateway: f.gateway,
	provider: f.provider ?? "(unknown)",
	model: f.model,
	action: f.action ?? "(unknown)",
	tag: f.tag ?? "(unknown)",
});

/**
 * What is traced: a node, or one band — one key of the band's thread column (the colour column,
 * or the first) along one segment between two neighbouring columns.
 */
type Selection =
	| { kind: "node"; column: FlowColumn; key: string }
	| { kind: "band"; thread: FlowColumn; key: string; fromColumn: FlowColumn; from: string; toColumn: FlowColumn; to: string };
/** The filters a drill applies: one for a node, up to three for a band, all of a table row's. The action and the tag are not page filters. */
export type FlowDrill = Partial<Record<Exclude<FlowColumn, "action" | "tag">, string>>;
const drillable = (column: FlowColumn, key: string): column is Exclude<FlowColumn, "action" | "tag"> =>
	column !== "action" && column !== "tag" && key !== OTHER && !UNDRILLABLE.has(key);

const sameSelection = (a: Selection | null, b: Selection | null) => JSON.stringify(a) === JSON.stringify(b);
/** A path without its action or tag: new and quiet are said of who reached which model, not of each outcome. */
const pathKey = (f: AiGatewayFlow) => JSON.stringify([f.user, f.gateway, f.provider, f.model]);
const sumNullable = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
/** Each path once, its actions and/or tags summed unless kept apart; p95 as a request-weighted mean. */
function mergeFlows(flows: AiGatewayFlow[], keepAction = false, keepTag = false): AiGatewayFlow[] {
	const byPath = new Map<string, { flow: AiGatewayFlow; latSum: number; latN: number }>();
	for (const f of flows) {
		const id = JSON.stringify([pathKey(f), keepAction ? f.action : null, keepTag ? f.tag : null]);
		const into = byPath.get(id) ?? { flow: { ...f, action: keepAction ? f.action : null, tag: keepTag ? f.tag : null, requests: 0, tokens: null, cost: null, errors: null, cached: null }, latSum: 0, latN: 0 };
		into.flow.requests += f.requests;
		into.flow.tokens = sumNullable(into.flow.tokens, f.tokens);
		into.flow.cost = sumNullable(into.flow.cost, f.cost);
		into.flow.errors = sumNullable(into.flow.errors, f.errors);
		into.flow.cached = sumNullable(into.flow.cached, f.cached);
		if (f.p95 !== null) {
			into.latSum += f.p95 * f.requests;
			into.latN += f.requests;
		}
		byPath.set(id, into);
	}
	return [...byPath.values()].map(({ flow, latSum, latN }) => ({ ...flow, p95: latN > 0 ? latSum / latN : null }));
}
/** How many new or quiet paths are listed before "and N more". */
const CHANGES_SHOWN = 4;

export type FlowColour = FlowColumn | "errors" | "cache" | "latency";
type HealthColour = "errors" | "cache" | "latency";
const isHealth = (c: FlowColour): c is HealthColour => c === "errors" || c === "cache" || c === "latency";

/**
 * Requests, failures and cache hits behind a band or node, for its health, and p95 latency as a
 * request-weighted sum (latSum over latN requests). null / 0: not reported.
 */
interface Health {
	requests: number;
	errors: number | null;
	cached: number | null;
	latSum: number;
	latN: number;
}
const emptyHealth = (): Health => ({ requests: 0, errors: null, cached: null, latSum: 0, latN: 0 });

const addHealth = (into: Health, from: Health) => {
	into.requests += from.requests;
	into.errors = from.errors === null ? into.errors : (into.errors ?? 0) + from.errors;
	into.cached = from.cached === null ? into.cached : (into.cached ?? 0) + from.cached;
	into.latSum += from.latSum;
	into.latN += from.latN;
};

/**
 * Three steps each, so a colour reads at a glance on a booth screen: errors under 1% are fine,
 * up to 5% worth a look, above that failing; a cache serving half the requests is working, a
 * tenth some, less than that hardly at all — grey rather than red, since not caching is a choice.
 */
export const HEALTH_STEPS: Record<HealthColour, { color: string; label: string; test: (rate: number) => boolean }[]> = {
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
	// p95 in ms. A model answer takes seconds; past a minute a user has likely given up.
	latency: [
		{ color: "#16a34a", label: "p95 under 10 s", test: (ms) => ms < 10_000 },
		{ color: "#d97706", label: "10–60 s", test: (ms) => ms < 60_000 },
		{ color: "#dc2626", label: "60 s or more", test: () => true },
	],
};

/** The rate a health colour reads — a share of requests, or for latency the p95 in ms. */
function healthRate(h: Health, by: HealthColour): number | null {
	if (by === "latency") return h.latN > 0 ? h.latSum / h.latN : null;
	const part = by === "errors" ? h.errors : h.cached;
	return part === null || h.requests <= 0 ? null : part / h.requests;
}

function healthColor(h: Health, by: HealthColour): string {
	const rate = healthRate(h, by);
	return rate === null ? OTHER_COLOR : HEALTH_STEPS[by].find((step) => step.test(rate))!.color;
}

const pctText = (rate: number) => `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
const msText = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

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
function topKeys(flows: { path: Path; value: number }[], column: FlowColumn): Set<string> {
	const totals = new Map<string, number>();
	for (const f of flows) totals.set(f.path[column], (totals.get(f.path[column]) ?? 0) + f.value);
	const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
	return new Set(sorted.length <= TOP + 1 ? sorted : sorted.slice(0, TOP));
}

const TOGGLE = `rounded-md px-2 py-0.5 ${FOCUS_RING}`;
const SMALL_BUTTON = `rounded-md border border-zinc-200 px-2.5 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`;

/** Presentation properties the page sets by class; copied onto the export so it looks the same outside the page. */
const EXPORTED_STYLES = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity", "font-size", "font-family", "font-weight", "paint-order"];

/**
 * The diagram as a standalone SVG: its computed colours and fonts inlined, the column names drawn
 * above it and the card's background behind, so it reads the same in slides as on the page.
 */
function snapshotSvg(svg: SVGSVGElement, headers: { text: string; x: number; anchor: "start" | "middle" | "end" }[]): { markup: string; width: number; height: number } {
	const width = Number(svg.getAttribute("width"));
	const top = 28;
	const height = Number(svg.getAttribute("height")) + top;
	const clone = svg.cloneNode(true) as SVGSVGElement;
	const from = [...svg.querySelectorAll("*")];
	const to = [...clone.querySelectorAll("*")];
	from.forEach((el, i) => {
		const style = getComputedStyle(el);
		const target = to[i] as SVGElement;
		// What a class set is inlined; what an attribute sets already travels with the element.
		const inline = EXPORTED_STYLES.filter((name) => !el.hasAttribute(name)).map((name) => `${name}:${style.getPropertyValue(name)}`);
		target.setAttribute("style", inline.join(";"));
	});
	// Page-only attributes go: data-* carry raw keys (a person's email even while names are hidden).
	for (const target of [clone, ...to]) {
		for (const attr of target.getAttributeNames()) if (["role", "tabindex", "aria-pressed", "aria-label", "class"].includes(attr) || attr.startsWith("data-")) target.removeAttribute(attr);
	}
	let bg = "#ffffff";
	for (let el: Element | null = svg; el; el = el.parentElement) {
		const c = getComputedStyle(el).backgroundColor;
		if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) {
			bg = c;
			break;
		}
	}
	const muted = getComputedStyle(svg.querySelector("text") ?? svg).fill || "#71717a";
	const font = getComputedStyle(svg).fontFamily;
	const ns = "http://www.w3.org/2000/svg";
	const body = document.createElementNS(ns, "g");
	body.setAttribute("transform", `translate(0,${top})`);
	while (clone.firstChild) body.appendChild(clone.firstChild);
	const backdrop = document.createElementNS(ns, "rect");
	for (const [k, v] of Object.entries({ width: String(width), height: String(height), fill: bg })) backdrop.setAttribute(k, v);
	clone.appendChild(backdrop);
	for (const h of headers) {
		const t = document.createElementNS(ns, "text");
		for (const [k, v] of Object.entries({ x: String(h.x), y: "16", "text-anchor": h.anchor, style: `fill:${muted};font-family:${font};font-size:12px;font-weight:600;letter-spacing:0.05em` })) t.setAttribute(k, v);
		t.textContent = h.text.toUpperCase();
		clone.appendChild(t);
	}
	clone.appendChild(body);
	clone.setAttribute("xmlns", ns);
	clone.setAttribute("height", String(height));
	clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
	clone.removeAttribute("class");
	return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

function savePng(markup: string, width: number, height: number, name: string) {
	const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
	const img = new Image();
	img.onload = () => {
		// Twice the size, so it stays sharp on a projector or a retina slide.
		const canvas = document.createElement("canvas");
		canvas.width = width * 2;
		canvas.height = height * 2;
		const ctx = canvas.getContext("2d");
		URL.revokeObjectURL(url);
		if (!ctx) return;
		ctx.scale(2, 2);
		ctx.drawImage(img, 0, 0);
		canvas.toBlob((blob) => blob && downloadBlob(name, blob), "image/png");
	};
	img.src = url;
}

type FlowMeasure = "requests" | "tokens" | "cost" | "errors";
const MEASURES: { id: FlowMeasure; label: string; format: (value: number) => string }[] = [
	{ id: "requests", label: "Requests", format: (v) => compactCount(v) },
	{ id: "tokens", label: "Tokens", format: (v) => compactCount(v) },
	{ id: "cost", label: "Spend", format: (v) => formatCost(v) },
	{ id: "errors", label: "Errors", format: (v) => compactCount(v) },
];

export function FlowSankey({
	flows,
	previousFlows,
	measure: chartMeasure,
	format: chartFormat,
	label,
	onPick,
	tagKey = null,
	blockedHref,
	blockedNote,
	routeNote,
}: {
	flows: AiGatewayFlow[];
	/** The same paths over the window before; new and quiet paths are told from these. */
	previousFlows?: AiGatewayFlow[] | null;
	/** The chart's measure, which sizes the bands unless the diagram is told otherwise. */
	measure: FlowMeasure;
	format: (value: number) => string;
	label: (column: FlowColumn, key: string) => string;
	onPick?: (drill: FlowDrill) => void;
	/** The page's tag key, which names the tag column. */
	tagKey?: string | null;
	/** Where a pinned "Blocked" trace links to: the WAF's AI Security events in the same window. */
	blockedHref?: string;
	/** Why the window's requests were blocked, from the AI Gateway logs, said on a pinned Blocked trace. */
	blockedNote?: string;
	/** Where a dynamic route (a `dynamic/…` model) can send a request, said when one is traced. */
	routeNote?: (model: string) => string | undefined;
}) {
	// What the pointer is over, and what a click pinned; a pin outlasts the pointer leaving.
	const [hovered, setHovered] = useState<Selection | null>(null);
	const [pinned, setPinned] = useState<Selection | null>(null);
	const [colourBy, setColourBy] = useState<FlowColour>("user");
	const [layoutId, setLayoutId] = useState(FLOW_LAYOUTS[0].id);
	const [cutoff, setCutoff] = useState(0);
	const [view, setView] = useState<"diagram" | "table">("diagram");
	// null: follow the chart, except with the action column (see below).
	const [sizeBy, setSizeBy] = useState<FlowMeasure | null>(null);
	const [touring, setTouring] = useState(false);
	const [boxRef, W] = useWidth();
	const svgRef = useRef<SVGSVGElement>(null);
	const colName = (c: FlowColumn) => (c === "tag" && tagKey ? tagKey : COLUMN_LABEL[c]);
	const layoutName = (columns: FlowColumn[]) => columns.map((c, i) => (i ? colName(c).toLowerCase() : colName(c))).join(" → ");

	// The provider column is offered only where the schema reports one per path.
	const hasProvider = flows.some((f) => f.provider !== null);
	const hasAction = flows.some((f) => f.action !== null);
	const hasTag = flows.some((f) => f.tag !== null);
	const layouts = FLOW_LAYOUTS.filter(
		(l) => (hasProvider || !l.columns.includes("provider")) && (hasAction || !l.columns.includes("action")) && (hasTag || !l.columns.includes("tag")),
	);
	const layout = layouts.find((l) => l.id === layoutId) ?? layouts[0];
	const cols = layout.columns;
	const first = cols[0];
	// What sizes the bands. With the action column it is requests unless picked otherwise: blocked,
	// cached and failed requests cost nothing, so by spend the actions worth seeing would not be drawn.
	const measureOptions = MEASURES.filter(
		(m) => m.id === "requests" || flows.some((f) => (m.id === "cost" ? f.cost : m.id === "tokens" ? f.tokens : f.errors) !== null),
	);
	const picked = sizeBy && measureOptions.some((m) => m.id === sizeBy) ? sizeBy : null;
	const measure: FlowMeasure = picked ?? (cols.includes("action") ? "requests" : chartMeasure);
	const format = measure === chartMeasure ? chartFormat : MEASURES.find((m) => m.id === measure)!.format;

	// Colour by any shown column; health colours only for what the schema reports per path.
	const colourOptions: { id: FlowColour; label: string }[] = [
		...cols.map((c) => ({ id: c as FlowColour, label: colName(c) })),
		...(flows.some((f) => f.errors !== null) ? [{ id: "errors" as const, label: "Error rate" }] : []),
		...(flows.some((f) => f.cached !== null) ? [{ id: "cache" as const, label: "Cache hit rate" }] : []),
		...(flows.some((f) => f.p95 !== null) ? [{ id: "latency" as const, label: "Latency (p95)" }] : []),
	];
	const colour: FlowColour = colourOptions.some((o) => o.id === colourBy) ? colourBy : first;
	// The column whose key a band carries across: the colour column, or the first for health colours.
	const thread: FlowColumn = isHealth(colour) ? first : colour;
	const valueOf = (f: AiGatewayFlow) => (measure === "cost" ? f.cost : measure === "tokens" ? f.tokens : measure === "errors" ? f.errors : f.requests) ?? 0;

	// Against the window before. Said only when that window had traffic to compare with — against
	// an empty one every path would read as new.
	const before = previousFlows?.length ? new Set(previousFlows.map(pathKey)) : null;
	const nowSeen = new Set(flows.map(pathKey));
	const isNewPath = (f: AiGatewayFlow) => Boolean(before) && !before!.has(pathKey(f));
	const merged = mergeFlows(flows);
	const newPaths = before ? merged.filter((f) => isNewPath(f) && valueOf(f) > 0).sort((a, b) => valueOf(b) - valueOf(a)) : [];
	const quietPaths = before ? mergeFlows(previousFlows!).filter((f) => !nowSeen.has(pathKey(f)) && valueOf(f) > 0).sort((a, b) => valueOf(b) - valueOf(a)) : [];
	// An outline marks the exception. When most paths are new (tagging only just started, say),
	// outlining most of the diagram would mark nothing, so the list says so instead.
	const outlineNew = Boolean(before) && newPaths.length * 2 <= merged.filter((f) => valueOf(f) > 0).length;
	// A band is new when no path of the window before ran along the same thread key and segment.
	const segmentId = (key: string, from: FlowColumn, a: string, to: FlowColumn, b: string) => JSON.stringify([key, from, a, to, b]);
	const seenSegments = new Set(
		(previousFlows ?? []).flatMap((f) => {
			const p = pathOf(f);
			return cols.slice(1).map((to, i) => segmentId(p[thread], cols[i], p[cols[i]], to, p[to]));
		}),
	);

	const valued = flows
		.map((f) => ({
			path: pathOf(f),
			value: valueOf(f),
			health: { requests: f.requests, errors: f.errors, cached: f.cached, latSum: f.p95 === null ? 0 : f.p95 * f.requests, latN: f.p95 === null ? 0 : f.requests } as Health,
		}))
		.filter((f) => f.value > 0);
	const wholeTotal = valued.reduce((n, p) => n + p.value, 0);
	// Paths under the cut-off are left out of the diagram (never out of the table or the export).
	const drawn = cutoff > 0 ? valued.filter((f) => f.value >= cutoff * wholeTotal) : valued;
	const hidden = { count: valued.length - drawn.length, value: wholeTotal - drawn.reduce((n, p) => n + p.value, 0) };
	const kept = Object.fromEntries(cols.map((c) => [c, topKeys(drawn, c)])) as Record<FlowColumn, Set<string>>;
	const paths = drawn.map((f) => ({
		value: f.value,
		health: f.health,
		path: { ...f.path, ...Object.fromEntries(cols.map((c) => [c, kept[c].has(f.path[c]) ? f.path[c] : OTHER])) } as Path,
	}));
	const total = paths.reduce((n, p) => n + p.value, 0);
	// What a column's "Other" holds, busiest first, in the same names and figures as everywhere else.
	const otherHolds = (column: FlowColumn) => {
		const sums = new Map<string, number>();
		for (const f of drawn) if (!kept[column].has(f.path[column])) sums.set(f.path[column], (sums.get(f.path[column]) ?? 0) + f.value);
		const list = [...sums].sort((a, b) => b[1] - a[1]);
		const named = list.slice(0, OTHER_NAMED).map(([key, value]) => `${label(column, key)} (${format(value)})`);
		return named.join(", ") + (list.length > OTHER_NAMED ? ` and ${list.length - OTHER_NAMED} more` : "");
	};

	// Geometry in real px, once the paths are known. Labels are 0.75rem; each side keeps room for one,
	// up to 17rem or 30% of the width, and a label longer than its room is cut with an ellipsis (full
	// name on hover).
	const font = 0.75 * rootPx();
	const charW = font * 0.6;
	// Each outer margin is as wide as its longest label with its value needs, up to the cap, so short
	// labels (actions, say) leave their width to the bands.
	const MAX_ROOM = Math.min(17 * rootPx(), W * 0.3);
	// The widest label a column draws, name and value, in px.
	const longest = (column: FlowColumn) => {
		const sums = new Map<string, number>();
		for (const p of paths) sums.set(p.path[column], (sums.get(p.path[column]) ?? 0) + p.value);
		return Math.max(0, ...[...sums].map(([key, value]) => `${label(column, key)} · ${format(value)}`.length)) * charW;
	};
	const marginFor = (column: FlowColumn) => Math.min(MAX_ROOM, Math.ceil(longest(column)) + 16);
	const ROOM_LEFT = marginFor(cols[0]);
	const ROOM_RIGHT = marginFor(cols[cols.length - 1]);
	// Columns spaced evenly between the two label margins.
	const span = W - ROOM_LEFT - ROOM_RIGHT - NODE_W;
	const X = Object.fromEntries(cols.map((c, i) => [c, ROOM_LEFT + (span * i) / (cols.length - 1)])) as Record<FlowColumn, number>;
	// Room for a label in px: either margin for the outer columns. A middle column's labels run into
	// the gap to the next one: its near half when they all fit there, so the far half can carry a
	// band's figure; otherwise the whole gap, since names matter more than figures. The first gap
	// has no labels in it, so it can always carry figures.
	const gapW = span / (cols.length - 1) - NODE_W;
	const halfGap = gapW / 2 - 8;
	const leavesHalf = Object.fromEntries(cols.map((c, i) => [c, i === 0 || (i < cols.length - 1 && longest(c) <= halfGap)])) as Record<FlowColumn, boolean>;
	const room = Object.fromEntries(
		cols.map((c, i) => [c, i === 0 ? ROOM_LEFT - 10 : i === cols.length - 1 ? ROOM_RIGHT - 10 : leavesHalf[c] ? halfGap : gapW - 14]),
	) as Record<FlowColumn, number>;
	// In a narrow card names matter more than figures: the value moves to the tooltip.
	const showValues = W >= 640;
	// A column too tight for a readable name beside its value drops the value too (it stays in the tooltip).
	const fit = (column: FlowColumn, name: string, value: string) => {
		const fits = Math.floor(room[column] / charW);
		const suffix = showValues && fits - value.length - 3 >= Math.min(name.length, 8) ? ` · ${value}` : "";
		const chars = Math.max(4, fits - suffix.length);
		return `${name.length > chars ? `${name.slice(0, chars - 1)}…` : name}${suffix}`;
	};
	// A node is never given less height than a line of its label, so neighbours' labels cannot overlap.
	const SLOT = Math.ceil(font * 1.5);

	const measureName = measure === "cost" ? "spend" : measure;
	// New and quiet are said per path, so their lines leave the action and the tag out.
	const pathCols = cols.filter((c) => c !== "action" && c !== "tag");
	// A full name on hover, except a person's, which stays as the label shows it (an alias while names are hidden).
	const fullName = (c: FlowColumn, key: string) => (c === "user" ? label(c, key) : key);
	const pathText = (f: AiGatewayFlow) => pathCols.map((c) => label(c, pathOf(f)[c])).join(" → ");
	const pathTitle = (f: AiGatewayFlow) => pathCols.map((c) => fullName(c, pathOf(f)[c])).join(" → ");

	// Every path for the table and the export, by the charted measure, then by requests: one row per
	// action and tag when they are columns, summed when they are not.
	const busiest = (list: AiGatewayFlow[]) => list.filter((f) => f.requests > 0 || valueOf(f) > 0).sort((a, b) => valueOf(b) - valueOf(a) || b.requests - a.requests);
	const rows = busiest(mergeFlows(flows, cols.includes("action"), cols.includes("tag")));
	const rowKey = (f: AiGatewayFlow) => JSON.stringify([pathKey(f), f.action, f.tag]);
	const rowDrill = (f: AiGatewayFlow): FlowDrill => {
		const p = pathOf(f);
		const drill: FlowDrill = {};
		for (const c of cols) if (drillable(c, p[c])) drill[c] = p[c];
		return drill;
	};
	const has = {
		tokens: flows.some((f) => f.tokens !== null),
		cost: flows.some((f) => f.cost !== null),
		errors: flows.some((f) => f.errors !== null),
		cached: flows.some((f) => f.cached !== null),
		p95: flows.some((f) => f.p95 !== null),
	};
	const exportCsv = () => {
		const csv = toCsv(busiest(flows), [
			{ header: "user", value: (f) => f.user },
			{ header: "gateway", value: (f) => f.gateway },
			...(hasProvider ? [{ header: "provider", value: (f: AiGatewayFlow) => f.provider ?? "" }] : []),
			{ header: "model", value: (f) => f.model },
			...(hasAction ? [{ header: "action", value: (f: AiGatewayFlow) => f.action ?? "" }] : []),
			...(hasTag ? [{ header: tagKey ? `tag:${tagKey}` : "tag", value: (f: AiGatewayFlow) => f.tag ?? "" }] : []),
			{ header: "requests", value: (f) => f.requests },
			{ header: "tokens", value: (f) => f.tokens ?? "" },
			{ header: "cost_usd", value: (f) => f.cost ?? "" },
			{ header: "errors", value: (f) => f.errors ?? "" },
			{ header: "cached", value: (f) => f.cached ?? "" },
			...(has.p95 ? [{ header: "p95_ms", value: (f: AiGatewayFlow) => (f.p95 === null ? "" : Math.round(f.p95)) }] : []),
			...(before ? [{ header: "new_this_window", value: (f: AiGatewayFlow) => (isNewPath(f) ? "yes" : "no") }] : []),
		]);
		downloadCsv(`flarelens-ai-gateway-paths-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	};

	// The tour: on a screen nobody is touching, trace the first column's busiest nodes in turn. Any
	// pick of the presenter's stops it.
	const tourSums = new Map<string, number>();
	for (const p of paths) if (p.path[first] !== OTHER) tourSums.set(p.path[first], (tourSums.get(p.path[first]) ?? 0) + p.value);
	const tourKeys = [...tourSums].sort((a, b) => b[1] - a[1]).slice(0, TOUR_STOPS).map(([key]) => key);
	const tourSignature = JSON.stringify([first, tourKeys]);
	useEffect(() => {
		if (!touring || view !== "diagram") return;
		const keys = JSON.parse(tourSignature)[1] as string[];
		if (!keys.length) return;
		let step = 0;
		const show = () => {
			setPinned({ kind: "node", column: first, key: keys[step % keys.length] });
			step += 1;
		};
		const start = setTimeout(show, 0);
		const timer = setInterval(show, TOUR_MS);
		return () => {
			clearTimeout(start);
			clearInterval(timer);
		};
	}, [touring, view, tourSignature, first]);
	const stopTour = () => setTouring(false);

	// The diagram as an image, for slides: the same colours, names (aliases while hidden) and figures.
	const exportImage = (kind: "svg" | "png") => {
		const svg = svgRef.current;
		if (!svg) return;
		const headers = cols.map((c, i) => ({
			text: colName(c),
			x: i === 0 ? 0 : i === cols.length - 1 ? W : X[c] + NODE_W / 2,
			anchor: (i === 0 ? "start" : i === cols.length - 1 ? "end" : "middle") as "start" | "middle" | "end",
		}));
		const { markup, width, height } = snapshotSvg(svg, headers);
		const name = `flarelens-who-uses-what-${new Date().toISOString().slice(0, 10)}`;
		if (kind === "svg") downloadBlob(`${name}.svg`, new Blob([markup], { type: "image/svg+xml" }));
		else savePng(markup, width, height, `${name}.png`);
	};

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
											<span className="min-w-0 flex-1 truncate" title={pathTitle(f)}>
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

	const controls = (
		<div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
			{view === "diagram" && (
				<>
					<label className="flex items-center gap-1.5">
						<span className={MUTED}>Columns</span>
						<select value={layout.id} onChange={(e) => setLayoutId(e.target.value)} className={SELECT_SM}>
							{layouts.map((l) => (
								<option key={l.id} value={l.id}>{layoutName(l.columns)}</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5">
						<span className={MUTED}>Size by</span>
						<select value={measure} onChange={(e) => setSizeBy(e.target.value as FlowMeasure)} className={SELECT_SM}>
							{measureOptions.map((m) => (
								<option key={m.id} value={m.id}>{m.label}</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5">
						<span className={MUTED}>Colour by</span>
						<select value={colour} onChange={(e) => setColourBy(e.target.value as FlowColour)} className={SELECT_SM}>
							{colourOptions.map((o) => (
								<option key={o.id} value={o.id}>{o.label}</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5">
						<span className={MUTED}>Small paths</span>
						<select value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))} className={SELECT_SM}>
							{CUTOFFS.map((c) => (
								<option key={c.share} value={c.share}>{c.label}</option>
							))}
						</select>
					</label>
				</>
			)}
			<span role="group" aria-label="View" className="flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
				{(["diagram", "table"] as const).map((v) => (
					<button
						key={v}
						type="button"
						aria-pressed={view === v}
						onClick={() => setView(v)}
						className={`${TOGGLE} ${view === v ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
					>
						{v === "diagram" ? "Diagram" : "Table"}
					</button>
				))}
			</span>
			{view === "diagram" && total > 0 && (
				<>
					<button
						type="button"
						aria-pressed={touring}
						onClick={() => {
							if (touring) setPinned(null);
							setTouring(!touring);
						}}
						title={`Trace the ${TOUR_STOPS} busiest ${colName(first).toLowerCase()}s in turn, ${TOUR_MS / 1000} s each`}
						className={`${SMALL_BUTTON} ${touring ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : ""}`}
					>
						{touring ? "Stop tour" : "Tour"}
					</button>
					<button type="button" onClick={() => exportImage("png")} className={SMALL_BUTTON}>
						Save PNG
					</button>
					<button type="button" onClick={() => exportImage("svg")} className={SMALL_BUTTON}>
						Save SVG
					</button>
				</>
			)}
			<button type="button" onClick={exportCsv} className={SMALL_BUTTON}>
				Export CSV
			</button>
		</div>
	);

	const pct = (part: number | null, whole: number) => (part === null ? "—" : whole > 0 ? pctText(part / whole) : "—");
	const table = (
		<div className="max-h-[32rem] overflow-auto">
			<table className="w-full text-left text-xs" aria-label="Every path">
				<thead className={`sticky top-0 bg-white dark:bg-zinc-900 ${MUTED}`}>
					<tr>
						{cols.map((c) => (
							<th key={c} scope="col" className="py-1.5 pr-3 font-medium">{colName(c)}</th>
						))}
						<th scope="col" className="py-1.5 pr-3 text-right font-medium">Requests</th>
						{has.tokens && <th scope="col" className="py-1.5 pr-3 text-right font-medium">Tokens</th>}
						{has.cost && <th scope="col" className="py-1.5 pr-3 text-right font-medium">Spend</th>}
						{has.errors && <th scope="col" className="py-1.5 pr-3 text-right font-medium">Errors</th>}
						{has.cached && <th scope="col" className="py-1.5 pr-3 text-right font-medium">From cache</th>}
						{has.p95 && <th scope="col" className="py-1.5 pr-3 text-right font-medium">p95</th>}
						{onPick && <th scope="col" className="py-1.5"><span className="sr-only">Drill</span></th>}
					</tr>
				</thead>
				<tbody>
					{rows.map((f) => {
						const p = pathOf(f);
						const drill = rowDrill(f);
						const parts = pathCols.filter((c) => drill[c]);
						return (
							<tr key={rowKey(f)} className="border-t border-zinc-100 dark:border-zinc-800">
								{cols.map((c, i) => (
									<td key={c} className="max-w-[16rem] truncate py-1.5 pr-3" title={fullName(c, p[c])}>
										{label(c, p[c])}
										{i === 0 && isNewPath(f) && <span className="ml-1.5 rounded bg-cf/10 px-1 text-[0.625rem] font-medium text-cf">new</span>}
									</td>
								))}
								<td className="py-1.5 pr-3 text-right tabular-nums">{compactCount(f.requests)}</td>
								{has.tokens && <td className="py-1.5 pr-3 text-right tabular-nums">{compactCount(f.tokens)}</td>}
								{has.cost && <td className="py-1.5 pr-3 text-right tabular-nums">{formatCost(f.cost)}</td>}
								{has.errors && (
									<td className="py-1.5 pr-3 text-right tabular-nums">
										{compactCount(f.errors)} <span className={MUTED}>({pct(f.errors, f.requests)})</span>
									</td>
								)}
								{has.cached && <td className="py-1.5 pr-3 text-right tabular-nums">{pct(f.cached, f.requests)}</td>}
								{has.p95 && <td className="py-1.5 pr-3 text-right tabular-nums">{f.p95 === null ? "—" : msText(f.p95)}</td>}
								{onPick && (
									<td className="py-1.5 text-right">
										{parts.length > 0 && (
											<button type="button" onClick={() => onPick(drill)} aria-label={`Drill into ${parts.map((c) => label(c, drill[c]!)).join(" · ")}`} className={`text-cf hover:underline ${FOCUS_RING}`}>
												Drill
											</button>
										)}
									</td>
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className={`mt-2 text-xs ${MUTED}`}>
				{rows.length} {rows.length === 1 ? "path" : "paths"}, busiest by {measureName} first; every path, whatever the diagram folds or leaves out.
			</p>
		</div>
	);

	const header = (
		<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<h2 id="aig-flows-title" className={SECTION_TITLE}>Who uses what</h2>
			<span className={`text-xs ${MUTED}`}>
				{layoutName(cols)}, sized by {measureName}.{view === "diagram" ? " Point at or tap a node or band to trace it." : ""}
			</span>
			{controls}
		</div>
	);
	const hiddenNote =
		view === "diagram" && hidden.count > 0 ? (
			<p className={`mt-2 text-xs ${MUTED}`}>
				{hidden.count} small {hidden.count === 1 ? "path" : "paths"} ({format(hidden.value)}, under {Math.round(cutoff * 100)}% each) left out; the table lists them.
			</p>
		) : null;
	// A band is as wide as its share of the measure, so requests that cost nothing — blocked, cached,
	// failed, or simply free — are not drawn when sizing by spend or tokens. Say so, and how to see them.
	const unsized = measure === "requests" ? [] : flows.filter((f) => f.requests > 0 && valueOf(f) <= 0);
	const unsizedRequests = unsized.reduce((n, f) => n + f.requests, 0);
	const unsizedActions = [...new Set(unsized.map((f) => f.action).filter((a): a is string => a !== null))];
	const unsizedNote =
		view === "diagram" && unsizedRequests > 0 ? (
			<p className={`mt-2 text-xs ${MUTED}`}>
				{compactCount(unsizedRequests)} {unsizedRequests === 1 ? "request carries" : "requests carry"} no {measureName}
				{unsizedActions.length ? ` (${unsizedActions.join(", ").toLowerCase()})` : ""}, so {unsizedRequests === 1 ? "it is" : "they are"} not drawn; size by requests to see{" "}
				{unsizedRequests === 1 ? "it" : "them"}.
			</p>
		) : null;

	return (
		<section
			className={CARD}
			aria-labelledby="aig-flows-title"
			onKeyDown={(e) => {
				if (e.key === "Escape" && pinned) {
					e.stopPropagation();
					setPinned(null);
					stopTour();
				}
			}}
		>
			{header}
			{/* Measured whichever view shows, so the diagram has its width the moment it is drawn. */}
			<div ref={boxRef}>
				{view === "table" ? (
					table
				) : total ? (
					renderDiagram()
				) : (
					<p className={`py-8 text-center text-sm ${MUTED}`}>No {layoutName(cols).toLowerCase()} {measureName} to show in this window.</p>
				)}
			</div>
			{hiddenNote}
			{unsizedNote}
			{changes}
		</section>
	);

	// The diagram itself; drawn only when there is something to draw.
	function renderDiagram() {
		// Node order and size per column; every column sums to the same total, so one scale fits all.
		const keysOf = (column: FlowColumn) => {
			const sums = new Map<string, number>();
			for (const p of paths) sums.set(p.path[column], (sums.get(p.path[column]) ?? 0) + p.value);
			// "Other" and the untagged remainder sit last, whatever their size.
			const last = (key: string) => key === OTHER || UNDRILLABLE.has(key);
			return [...sums.entries()].sort((a, b) => Number(last(a[0])) - Number(last(b[0])) || b[1] - a[1]);
		};
		const sorted = Object.fromEntries(cols.map((c) => [c, keysOf(c)])) as Record<FlowColumn, [string, number][]>;
		const most = Math.max(...cols.map((c) => sorted[c].length));
		// Bands share one scale; the plot is as tall as the busiest column needs, at least 14rem.
		const target = Math.max(14 * rootPx(), most * (SLOT + GAP) * 1.6);
		const scale = Math.min(...cols.map((c) => (target - GAP * (sorted[c].length - 1)) / total));
		const advance = (value: number) => Math.max(value * scale, SLOT) + GAP;
		const extent = (c: FlowColumn) => sorted[c].reduce((n, [, v]) => n + advance(v), 0) - GAP;
		const H = Math.ceil(Math.max(...cols.map(extent)));
		const nodes = Object.fromEntries(
			cols.map((c) => {
				// Centre a shorter column vertically against the tallest; a node below a line's height
				// keeps its true thickness but takes a line's room.
				let y = (H - extent(c)) / 2;
				const list = sorted[c].map(([key, value]) => {
					const h = Math.max(1, value * scale);
					const slot = Math.max(h, SLOT);
					const node: Node = { key, value, y: y + (slot - h) / 2, h };
					y += slot + GAP;
					return node;
				});
				return [c, new Map(list.map((n) => [n.key, n]))];
			}),
		) as Record<FlowColumn, Map<string, Node>>;
		const order = (column: FlowColumn, key: string) => [...nodes[column].keys()].indexOf(key);
		const catColor = (column: FlowColumn, key: string) =>
			column === "action" ? (ACTION_COLORS[key] ?? OTHER_COLOR) : key === OTHER || UNDRILLABLE.has(key) ? OTHER_COLOR : STACK_COLORS[order(column, key) % STACK_COLORS.length];
		// Health per node, summed over the paths through it.
		const nodeHealth = (column: FlowColumn, key: string) => {
			const h = emptyHealth();
			for (const p of paths) if (p.path[column] === key) addHealth(h, p.health);
			return h;
		};
		const healthNote = (h: Health) => {
			if (!isHealth(colour)) return "";
			const rate = healthRate(h, colour);
			if (rate === null) return "";
			return colour === "latency" ? ` · p95 ≈ ${msText(rate)}` : ` · ${pctText(rate)} ${colour === "errors" ? "errors" : "from cache"}`;
		};

		// Whether a path runs through what is traced.
		const through = (sel: Selection, p: (typeof paths)[number]) =>
			sel.kind === "node" ? p.path[sel.column] === sel.key : p.path[sel.thread] === sel.key && p.path[sel.fromColumn] === sel.from && p.path[sel.toColumn] === sel.to;

		// One link stage per pair of neighbouring columns, aggregated, each band keyed by its thread
		// key so it carries that key's colour across every column.
		const stage = (from: FlowColumn, to: FlowColumn, active: Selection | null) => {
			const bands = new Map<string, { key: string; from: string; to: string; value: number; lit: number; health: Health }>();
			for (const p of paths) {
				const id = JSON.stringify([p.path[thread], p.path[from], p.path[to]]);
				const band = bands.get(id) ?? { key: p.path[thread], from: p.path[from], to: p.path[to], value: 0, lit: 0, health: emptyHealth() };
				band.value += p.value;
				addHealth(band.health, p.health);
				if (!active || through(active, p)) band.lit += p.value;
				bands.set(id, band);
			}
			// Stack bands at each end in the order of the node at the other end, so they cross least.
			const outOffset = new Map<string, number>();
			const inOffset = new Map<string, number>();
			const placed = [...bands.values()]
				.sort((a, b) => order(to, a.to) - order(to, b.to) || order(thread, a.key) - order(thread, b.key))
				.map((b) => {
					const offset = outOffset.get(b.from) ?? 0;
					outOffset.set(b.from, offset + b.value * scale);
					return { ...b, y0: nodes[from].get(b.from)!.y + offset };
				})
				.sort((a, b) => order(from, a.from) - order(from, b.from) || order(thread, a.key) - order(thread, b.key))
				.map((b) => {
					const offset = inOffset.get(b.to) ?? 0;
					inOffset.set(b.to, offset + b.value * scale);
					return { ...b, y1: nodes[to].get(b.to)!.y + offset };
				});
			return placed.map((b) => {
				const selection: Selection = { kind: "band", thread, key: b.key, fromColumn: from, from: b.from, toColumn: to, to: b.to };
				const folded = b.key === OTHER || b.from === OTHER || b.to === OTHER;
				const isNew = outlineNew && !folded && !seenSegments.has(segmentId(b.key, from, b.from, to, b.to));
				return { ...b, selection, isNew, fromColumn: from, toColumn: to, x0: X[from] + NODE_W, x1: X[to] };
			});
		};
		const stages = (active: Selection | null) => cols.slice(1).flatMap((to, i) => stage(cols[i], to, active));

		// A pin on something no longer drawn (another window, measure or layout) is simply not shown.
		const drawnBands = stages(null);
		const shown = (sel: Selection | null): Selection | null =>
			!sel ? null : sel.kind === "node" ? (nodes[sel.column]?.has(sel.key) ? sel : null) : drawnBands.some((b) => sameSelection(b.selection, sel)) ? sel : null;
		const pin = shown(pinned);
		const active = pin ?? shown(hovered);
		const bands = active ? stages(active) : drawnBands;
		// The biggest bands carry their figure, at the near side of the node they run into — where no
		// label reaches. A band thinner than a line of text carries none.
		const figures = [...drawnBands]
			.filter((b) => b.value * scale >= SLOT && leavesHalf[b.fromColumn])
			.sort((a, b) => b.value - a.value)
			.slice(0, FIGURES);

		const bandColor = (b: (typeof bands)[number]) => (isHealth(colour) ? healthColor(b.health, colour) : catColor(colour, b.key));
		const ribbon = (x0: number, y0: number, x1: number, y1: number, h: number) => {
			const mid = (x0 + x1) / 2;
			return `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z`;
		};
		const counts = cols.map((c) => `${nodes[c].size} ${colName(c).toLowerCase()}${nodes[c].size === 1 ? "" : "s"}`).join(", ");
		const toggle = (sel: Selection) => {
			stopTour();
			setPinned((now) => (sameSelection(now, sel) ? null : sel));
		};
		const pressKeys = (sel: Selection) => (e: React.KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle(sel);
			}
		};
		const bandName = (b: { fromColumn: FlowColumn; from: string; toColumn: FlowColumn; to: string; key: string }) =>
			`${b.fromColumn === thread ? "" : `${label(thread, b.key)}: `}${label(b.fromColumn, b.from)} → ${label(b.toColumn, b.to)}`;

		// What a selection says and drills into. A band carries its thread key, so its drill is that
		// key (when drillable) plus both ends; anything folded or untagged is left out of the filter.
		const describe = (sel: Selection) => {
			if (sel.kind === "node") {
				const node = nodes[sel.column].get(sel.key)!;
				return {
					title: `${colName(sel.column).toLowerCase()} ${label(sel.column, sel.key)}`,
					value: node.value,
					health: nodeHealth(sel.column, sel.key),
					drill: drillable(sel.column, sel.key) ? ({ [sel.column]: sel.key } as FlowDrill) : {},
				};
			}
			const band = drawnBands.find((b) => sameSelection(b.selection, sel))!;
			const drill: FlowDrill = {};
			for (const [column, key] of [[sel.thread, sel.key], [sel.fromColumn, sel.from], [sel.toColumn, sel.to]] as [FlowColumn, string][]) if (drillable(column, key)) drill[column] = key;
			return { title: bandName(band), value: band.value, health: band.health, drill };
		};
		const pinInfo = pin ? describe(pin) : null;
		const drillParts = pinInfo ? pathCols.filter((c) => pinInfo.drill[c]) : [];
		// A trace through a dynamic route says where that route can send a request.
		const pinnedModel =
			pin === null
				? null
				: pin.kind === "node"
					? pin.column === "model"
						? pin.key
						: null
					: (([[pin.thread, pin.key], [pin.fromColumn, pin.from], [pin.toColumn, pin.to]] as [FlowColumn, string][]).find(([c]) => c === "model")?.[1] ?? null);
		const pinnedRoute = pinnedModel?.startsWith("dynamic/") ? routeNote?.(pinnedModel) : undefined;
		// A trace through "Blocked" links on to the WAF's AI Security events of the same window.
		const tracesBlocked =
			pin !== null &&
			(pin.kind === "node"
				? pin.column === "action" && pin.key === "Blocked"
				: (pin.thread === "action" && pin.key === "Blocked") || (pin.fromColumn === "action" && pin.from === "Blocked") || (pin.toColumn === "action" && pin.to === "Blocked"));

		return (
			<>
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
							{tracesBlocked && blockedHref && (
								<a href={blockedHref} className={`${SMALL_BUTTON} text-cf`}>
									AI Security events in this window →
								</a>
							)}
							<button
								type="button"
								onClick={() => {
									setPinned(null);
									stopTour();
								}}
								className={SMALL_BUTTON}
							>
								Clear <kbd className="font-mono text-[10px] text-zinc-400">Esc</kbd>
							</button>
						</span>
						{tracesBlocked && blockedNote && (
							<p className={`basis-full ${MUTED}`}>
								<span className="font-medium text-zinc-700 dark:text-zinc-200">Why blocked: </span>
								{blockedNote}.
							</p>
						)}
						{pinnedRoute && <p className={`basis-full ${MUTED}`}>{pinnedRoute}.</p>}
						{pin.kind === "node" && pin.key === OTHER && <p className={`basis-full ${MUTED}`}>Holds {otherHolds(pin.column)}.</p>}
					</div>
				)}
				<div>
					<div className={`relative mb-1 h-4 text-xs font-medium uppercase tracking-wide ${MUTED}`} aria-hidden>
						{cols.map((c, i) => (
							<span
								key={c}
								className="absolute top-0 whitespace-nowrap"
								style={i === 0 ? { left: 0 } : i === cols.length - 1 ? { right: 0 } : { left: X[c] + NODE_W / 2, transform: "translateX(-50%)" }}
							>
								{colName(c)}
							</span>
						))}
					</div>
					<svg
						ref={svgRef}
						width={W}
						height={H}
						viewBox={`0 0 ${W} ${H}`}
						className="block max-w-full"
						role="group"
						aria-label={`Flows from ${cols.map((c) => `${colName(c).toLowerCase()}s`).join(" to ")}: ${counts}`}
						onMouseLeave={() => setHovered(null)}
					>
						<g>
							{bands.map((b) => {
								const isPinned = sameSelection(pin, b.selection);
								const name = bandName(b);
								return (
									<path
										key={JSON.stringify(b.selection)}
										d={ribbon(b.x0, b.y0, b.x1, b.y1, Math.max(0.5, b.value * scale))}
										fill={bandColor(b)}
										fillOpacity={active ? 0.08 : isHealth(colour) ? 0.55 : 0.35}
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
						<g pointerEvents="none" aria-hidden>
							{figures.map((b) => (
								<text
									key={`figure-${JSON.stringify(b.selection)}`}
									x={b.x1 - 6}
									y={b.y1 + (b.value * scale) / 2}
									dominantBaseline="middle"
									textAnchor="end"
									className="fill-zinc-900 stroke-white text-[0.75rem] font-semibold tabular-nums dark:fill-white dark:stroke-zinc-900"
									strokeWidth={3}
									paintOrder="stroke"
									opacity={active && !b.lit ? 0.3 : 1}
									data-figure={`${b.fromColumn}:${b.from}>${b.toColumn}:${b.to}`}
								>
									{format(b.value)}
								</text>
							))}
						</g>
						{cols.map((column, i) =>
							[...nodes[column].values()].map((node) => {
								const sel: Selection = { kind: "node", column, key: node.key };
								const text = fit(column, label(column, node.key), format(node.value));
								const health = nodeHealth(column, node.key);
								// An action node keeps its own colour whatever the bands are coloured by.
								const fill = isHealth(colour)
									? healthColor(health, colour)
									: column === colour || column === "action"
										? catColor(column, node.key)
										: node.key === OTHER
											? OTHER_COLOR
											: "#71717a";
								const isPinned = sameSelection(pin, sel);
								const isActive = sameSelection(active, sel);
								const isFirst = i === 0;
								const isLast = i === cols.length - 1;
								// The node and its label, so a thin node is still easy to point at.
								const hit = isFirst ? { x: 0, w: X[column] + NODE_W } : isLast ? { x: X[column], w: W - X[column] } : { x: X[column], w: NODE_W + room[column] + 6 };
								const labelX = isFirst ? X[column] - 8 : isLast ? X[column] + NODE_W + 8 : X[column] + NODE_W + 6;
								return (
									<g
										key={`${column}-${node.key}`}
										role="button"
										tabIndex={0}
										aria-pressed={isPinned}
										aria-label={`${colName(column)} ${label(column, node.key)}: ${format(node.value)}${healthNote(health)}. ${isPinned ? "Tracing; select again to stop" : "Select to trace its paths"}`}
										className={`cursor-pointer outline-none ${FOCUS_RING}`}
										onMouseEnter={() => setHovered(sel)}
										onFocus={() => setHovered(sel)}
										onBlur={() => setHovered(null)}
										onClick={() => toggle(sel)}
										onKeyDown={pressKeys(sel)}
									>
										<title>{`${label(column, node.key)}: ${format(node.value)} (${Math.round((node.value / total) * 100)}%)${healthNote(health)}${node.key === OTHER ? ` — ${otherHolds(column)}` : ""}`}</title>
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
											textAnchor={isFirst ? "end" : "start"}
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
				{(isHealth(colour) || drawnBands.some((b) => b.isNew)) && (
					<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Colour key">
						{isHealth(colour) && (
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
				{cols.includes("action") && (
					<div className="mt-2 text-xs">
						<ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Actions">
							{[...nodes.action.keys()].map((key) => (
								<li key={key} className="flex items-center gap-1.5">
									<span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: catColor("action", key) }} />
									{key}
								</li>
							))}
						</ul>
						<p className={`mt-1 ${MUTED}`}>
							Told from each request's status, as AI Gateway records no action as such: Blocked is HTTP 422 or 424, how Guardrails refuse a prompt or response (a
							provider's own 422 or 424 would count too); a DLP block answers 400, which reads as Failed like any bad request; Cancelled is 499, the client gone
							before the answer; Failed is any other error.
						</p>
					</div>
				)}
			</>
		);
	}
}

import { useMemo } from "react";
import { MUTED } from "../../lib/ui";
import { buildSankey, SANKEY_NODE_WIDTH, type SankeyTone } from "./sankey";
import type { MappingRow } from "./types";

/**
 * The tunnel map as a flow: how many destinations are gated, which tunnel carries them, and what
 * answers at the other end.
 *
 * Drawn rather than tabulated because the finding here is proportion — the table below already
 * says what each row is, and cannot say that most of the estate is gated but reaches no tunnel.
 * Inline SVG, like every other chart in this app: the CSP allows scripts from 'self' only, so a
 * charting library could not run even if one were worth the bundle.
 */

/**
 * Tones carry meaning, not decoration, so they come from the same semantic set the rest of the
 * page uses: red is a destination reachable with no Access policy, amber is a check that produced
 * no answer, and grey is an origin that legitimately never involves a tunnel.
 */
const TONE_FILL: Record<SankeyTone, string> = {
	ok: "fill-emerald-500",
	exposed: "fill-red-500",
	gap: "fill-amber-500",
	down: "fill-red-600",
	neutral: "fill-zinc-400 dark:fill-zinc-500",
};

const TONE_TEXT: Record<SankeyTone, string> = {
	ok: "fill-emerald-700 dark:fill-emerald-400",
	exposed: "fill-red-600 dark:fill-red-400",
	gap: "fill-amber-700 dark:fill-amber-400",
	down: "fill-red-600 dark:fill-red-400",
	neutral: "fill-zinc-500 dark:fill-zinc-400",
};

const RIBBON_OPACITY: Record<SankeyTone, number> = {
	ok: 0.26,
	exposed: 0.34,
	gap: 0.3,
	down: 0.36,
	neutral: 0.18,
};

/**
 * Column headers sit with their own labels: the tunnel names hang to the left of the middle column
 * to stay clear of the ribbons, so its header is right-aligned there too. A header drifting away
 * from the column it names is worse than no header.
 */
const COLUMN_TITLES: { x: (w: number) => number; label: string; anchor: "start" | "end" }[] = [
	{ x: () => 90, label: "ACCESS", anchor: "start" },
	{ x: (w) => w / 2 - SANKEY_NODE_WIDTH / 2 - 8, label: "TUNNEL", anchor: "end" },
	{ x: (w) => w - 120, label: "ORIGIN", anchor: "start" },
];

function summarise(total: number, exposed: number, unclassified: number): string {
	const parts = [`${total} destinations`];
	if (exposed) parts.push(`${exposed} reachable with no Access policy`);
	if (unclassified) parts.push(`${unclassified} with an origin that could not be identified`);
	return `Flow from Access gate to tunnel to origin: ${parts.join(", ")}.`;
}

export function TunnelSankey({
	rows,
	onSelectTunnel,
}: {
	rows: MappingRow[];
	/** A tunnel node is a filter: clicking it narrows the table below to that tunnel. */
	onSelectTunnel: (name: string) => void;
}) {
	const layout = useMemo(() => buildSankey(rows), [rows]);

	if (layout.nodes.length === 0) return null;

	const exposed = rows.filter((r) => r.tunnel && !r.app && r.hostname !== "(catch-all)").length;
	const unclassified = rows.filter((r) => r.originKind === "unknown").length;

	return (
		<div className="overflow-x-auto">
			<svg
				viewBox={`0 0 ${layout.width} ${layout.height}`}
				className="w-full min-w-[720px]"
				role="img"
				aria-label={summarise(layout.total, exposed, unclassified)}
			>
				{COLUMN_TITLES.map((col) => (
					<text
						key={col.label}
						x={col.x(layout.width)}
						y={22}
						textAnchor={col.anchor}
						className="fill-zinc-500 text-[11px] tracking-widest dark:fill-zinc-400"
						fontFamily="ui-monospace, monospace"
					>
						{col.label}
					</text>
				))}

				{layout.links.map((link) => (
					<path key={link.id} d={link.path} className={TONE_FILL[link.tone]} opacity={RIBBON_OPACITY[link.tone]} />
				))}

				{layout.nodes.map((node) => {
					const clickable = node.filter !== "";
					const label = `${node.label} · ${node.value}${node.note ? ` · ${node.note}` : ""}`;
					return (
						<g
							key={node.id}
							{...(clickable
								? {
										role: "button",
										tabIndex: 0,
										"aria-label": `Filter the table to ${node.label}`,
										onClick: () => onSelectTunnel(node.filter),
										onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												onSelectTunnel(node.filter);
											}
										},
										className: "cursor-pointer focus-visible:outline-2 focus-visible:outline-cf",
									}
								: {})}
						>
							<rect x={node.x} y={node.y} width={SANKEY_NODE_WIDTH} height={node.height} className={TONE_FILL[node.tone]} />
							<text
								x={node.column === "tunnel" ? node.x - 8 : node.x}
								y={node.y - 5}
								textAnchor={node.column === "tunnel" ? "end" : "start"}
								className={`${TONE_TEXT[node.tone]} text-[10.5px]`}
								fontFamily="ui-monospace, monospace"
							>
								{label}
							</text>
						</g>
					);
				})}

				<text
					x={90}
					y={layout.height - 8}
					className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
					fontFamily="ui-monospace, monospace"
				>
					one ribbon row = one destination · {layout.total} total · click a tunnel to filter
				</text>
			</svg>

			<div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs ${MUTED}`}>
				<span><span className="mr-1.5 inline-block h-2 w-5 rounded-sm bg-emerald-500/40 align-middle" />reaches a tunnel</span>
				<span><span className="mr-1.5 inline-block h-2 w-5 rounded-sm bg-red-500/40 align-middle" />no Access policy in front</span>
				<span><span className="mr-1.5 inline-block h-2 w-5 rounded-sm bg-amber-500/40 align-middle" />origin not identified</span>
				<span><span className="mr-1.5 inline-block h-2 w-5 rounded-sm bg-zinc-400/40 align-middle" />Worker or Cloudflare, no tunnel needed</span>
			</div>
		</div>
	);
}

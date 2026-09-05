import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

/**
 * Shared hover readout for the inline-SVG charts.
 *
 * Every chart in the app draws its own SVG rather than pulling in a charting library, so none of
 * them came with a tooltip. SVG `<title>` was doing the job on the bar charts, but it is the
 * browser's native tooltip: ~1s delay, one element at a time, and no way to show every series at
 * the hovered bucket. This replaces it with a real readout — one row per series, at the bucket
 * under the cursor.
 *
 * Geometry stays with each chart because they differ (columns vs lines, different padding); what
 * is shared is the pointer maths, the state, and the rendering.
 */

export interface TooltipRow {
	label: string;
	value: string;
	/** Swatch colour. Omit for a row with no series colour. */
	color?: string;
	/** Renders the row dimmed — used for a zero value that is present but uninteresting. */
	muted?: boolean;
}

export interface HoverPoint {
	/** Index of the hovered bucket. */
	index: number;
	/** Cursor position in CSS pixels, relative to the chart wrapper. */
	x: number;
	y: number;
	/** Wrapper size in CSS pixels, so the readout can keep itself inside it. */
	width: number;
	height: number;
}

/**
 * Convert a pointer event into a position in the SVG's own viewBox coordinates.
 *
 * The charts set a viewBox and size themselves with CSS, so the default
 * `preserveAspectRatio="xMidYMid meet"` letterboxes the drawing inside the element box. Scaling
 * by `rect.width / viewWidth` alone is therefore wrong whenever the element's aspect ratio does
 * not match the viewBox's, which is the normal case here (`h-56 w-full`).
 */
function viewBoxX(event: ReactMouseEvent<SVGSVGElement>, viewWidth: number, viewHeight: number): number | null {
	const rect = event.currentTarget.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) return null;
	const scale = Math.min(rect.width / viewWidth, rect.height / viewHeight);
	if (scale <= 0) return null;
	const offsetX = (rect.width - viewWidth * scale) / 2;
	return (event.clientX - rect.left - offsetX) / scale;
}

export interface ChartHoverOptions {
	/** Number of buckets on the x axis. */
	count: number;
	/** viewBox dimensions. */
	viewWidth: number;
	viewHeight: number;
	/** x of the first bucket (line) or the left edge of the first slot (columns). */
	plotLeft: number;
	/** x of the last bucket (line) or the right edge of the last slot (columns). */
	plotRight: number;
	/**
	 * "point" snaps to the nearest bucket centre — right for lines, where a value exists only at
	 * each vertex. "slot" divides the plot into `count` equal columns — right for bar charts,
	 * where anywhere inside a column belongs to that bucket.
	 */
	mode: "point" | "slot";
}

/**
 * Which bucket a position along the plot belongs to, or null when the cursor is outside it.
 *
 * Split out from the hook so the arithmetic — the part that silently mislabels every tooltip
 * when it drifts — is testable without a DOM.
 */
export function bucketIndexAt(ratio: number, count: number, mode: ChartHoverOptions["mode"]): number | null {
	if (count <= 0) return null;
	// A small tolerance either side: the first and last bars sit right on the plot edge, and
	// requiring a strictly interior pixel makes them feel dead.
	if (ratio < -0.02 || ratio > 1.02) return null;
	const raw = mode === "point" ? Math.round(ratio * (count - 1)) : Math.floor(ratio * count);
	return Math.max(0, Math.min(count - 1, raw));
}

export function useChartHover({ count, viewWidth, viewHeight, plotLeft, plotRight, mode }: ChartHoverOptions) {
	const [hover, setHover] = useState<HoverPoint | null>(null);

	const onMouseMove = useCallback(
		(event: ReactMouseEvent<SVGSVGElement>) => {
			if (count === 0) return;
			const x = viewBoxX(event, viewWidth, viewHeight);
			if (x === null) return;
			const span = plotRight - plotLeft;
			if (span <= 0) return;

			const index = bucketIndexAt((x - plotLeft) / span, count, mode);
			// Outside the plot area entirely: drop the readout rather than clamping to an edge
			// bucket the cursor is not actually over.
			if (index === null) {
				setHover(null);
				return;
			}

			const rect = event.currentTarget.getBoundingClientRect();
			setHover({
				index,
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
				width: rect.width,
				height: rect.height,
			});
		},
		[count, viewWidth, viewHeight, plotLeft, plotRight, mode],
	);

	const onMouseLeave = useCallback(() => setHover(null), []);

	return {
		hover,
		/** Spread onto the <svg>. */
		hoverProps: { onMouseMove, onMouseLeave },
	};
}

/** Distance between cursor and readout, and the margin kept against the wrapper's edges. */
const TOOLTIP_GAP = 12;
const TOOLTIP_EDGE = 6;

/**
 * Where to put the readout so it stays inside the chart.
 *
 * Pure and exported because this is exactly what was wrong before: a fixed
 * `translate(-50%, -100%)` clipped the box against the top of the chart whenever the cursor was
 * near a peak — which is most of the time — and ran it off the right edge on the last buckets.
 */
export function placeTooltip(
	hover: Pick<HoverPoint, "x" | "y" | "width" | "height">,
	size: { width: number; height: number },
): { left: number; top: number } {
	// Centred on the cursor, then pulled back inside whichever edge it would cross.
	const maxLeft = Math.max(TOOLTIP_EDGE, hover.width - size.width - TOOLTIP_EDGE);
	const left = Math.min(Math.max(hover.x - size.width / 2, TOOLTIP_EDGE), maxLeft);

	// Above the cursor by default; flipped below when there is not enough room above.
	const above = hover.y - size.height - TOOLTIP_GAP;
	const candidate = above < TOOLTIP_EDGE ? hover.y + TOOLTIP_GAP : above;
	const maxTop = Math.max(TOOLTIP_EDGE, hover.height - size.height - TOOLTIP_EDGE);
	return { left, top: Math.min(candidate, maxTop) };
}

/**
 * Floating readout. Positioned against the chart wrapper, which must be `relative` and must be
 * the SVG's own offset parent — hover coordinates are measured from the SVG, so anchoring to a
 * card that also contains a heading would shift the readout by the heading's height.
 *
 * Placement is measured rather than guessed: the box is laid out, its real size read back, and
 * then clamped inside the wrapper. Without that it clips against the top of the chart (the
 * common case, since the cursor is usually near a peak) and runs off the right-hand edge on the
 * last few buckets.
 */
export function ChartTooltip({
	hover,
	header,
	rows,
	footer,
}: {
	hover: HoverPoint | null;
	header: string;
	rows: TooltipRow[];
	footer?: ReactNode;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	// Measured after layout, before paint, so the first frame at a new bucket is already in the
	// right place rather than visibly jumping.
	useLayoutEffect(() => {
		if (!boxRef.current) return;
		const rect = boxRef.current.getBoundingClientRect();
		setSize((prev) =>
			Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
				? prev
				: { width: rect.width, height: rect.height },
		);
	}, [hover?.index, header, rows, footer]);

	if (!hover) return null;

	const measured = size.width > 0 && size.height > 0;
	const { left, top } = placeTooltip(hover, size);

	return (
		<div
			ref={boxRef}
			role="status"
			aria-live="polite"
			className="pointer-events-none absolute z-20 min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg dark:border-zinc-600"
			style={{
				left,
				top,
				maxWidth: `min(320px, ${Math.max(120, hover.width - TOOLTIP_EDGE * 2)}px)`,
				// Hidden only for the very first frame at a new size, before the measurement lands.
				visibility: measured ? "visible" : "hidden",
			}}
		>
			<div className="mb-1.5 font-semibold text-white">{header}</div>
			<ul className="space-y-0.5">
				{rows.map((row) => (
					<li key={row.label} className={`flex items-center gap-2 ${row.muted ? "opacity-60" : ""}`}>
						{row.color && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: row.color }} aria-hidden />}
						<span className="min-w-0 flex-1 truncate text-zinc-300">{row.label}</span>
						<span className="shrink-0 font-medium tabular-nums text-white">{row.value}</span>
					</li>
				))}
			</ul>
			{footer && <div className="mt-1.5 border-t border-zinc-700 pt-1.5 text-zinc-300">{footer}</div>}
		</div>
	);
}

/** Vertical guide at the hovered bucket, drawn inside the SVG. */
export function HoverGuide({ x, top, bottom }: { x: number; top: number; bottom: number }) {
	return (
		<line
			x1={x}
			x2={x}
			y1={top}
			y2={bottom}
			className="stroke-zinc-400 dark:stroke-zinc-500"
			strokeWidth={1}
			strokeDasharray="3 3"
			pointerEvents="none"
		/>
	);
}

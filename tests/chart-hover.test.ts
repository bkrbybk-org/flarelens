import { describe, expect, it } from "vitest";
import { bucketIndexAt, placeTooltip } from "../web/src/components/chart/ChartHover";

/**
 * The hover readout is only as good as this mapping: get it wrong and every chart confidently
 * reports the wrong bucket's numbers, which is worse than having no tooltip at all.
 */

describe("bucketIndexAt — line charts (nearest vertex)", () => {
	const count = 5; // vertices at ratio 0, .25, .5, .75, 1

	it("snaps to the nearest vertex", () => {
		expect(bucketIndexAt(0, count, "point")).toBe(0);
		expect(bucketIndexAt(0.5, count, "point")).toBe(2);
		expect(bucketIndexAt(1, count, "point")).toBe(4);
	});

	it("rounds to whichever vertex is closer", () => {
		expect(bucketIndexAt(0.3, count, "point")).toBe(1);
		expect(bucketIndexAt(0.4, count, "point")).toBe(2);
	});

	it("never returns an index past the last vertex", () => {
		expect(bucketIndexAt(1.02, count, "point")).toBe(4);
	});
});

describe("bucketIndexAt — bar charts (column slots)", () => {
	const count = 4; // slots [0,.25) [.25,.5) [.5,.75) [.75,1]

	it("maps a position to the column that contains it", () => {
		expect(bucketIndexAt(0.0, count, "slot")).toBe(0);
		expect(bucketIndexAt(0.24, count, "slot")).toBe(0);
		expect(bucketIndexAt(0.26, count, "slot")).toBe(1);
		expect(bucketIndexAt(0.99, count, "slot")).toBe(3);
	});

	it("keeps the right edge inside the last column rather than overflowing", () => {
		// floor(1 * 4) would be 4, which is off the end.
		expect(bucketIndexAt(1, count, "slot")).toBe(3);
	});
});

describe("bucketIndexAt — outside the plot", () => {
	it("returns null well outside either edge", () => {
		expect(bucketIndexAt(-0.5, 10, "point")).toBeNull();
		expect(bucketIndexAt(1.5, 10, "slot")).toBeNull();
	});

	it("tolerates a sliver past each edge so the end bars stay hoverable", () => {
		expect(bucketIndexAt(-0.01, 10, "slot")).toBe(0);
		expect(bucketIndexAt(1.01, 10, "slot")).toBe(9);
	});

	it("returns null when there is nothing to hover", () => {
		expect(bucketIndexAt(0.5, 0, "point")).toBeNull();
	});

	it("handles a single-bucket chart in both modes", () => {
		expect(bucketIndexAt(0.5, 1, "point")).toBe(0);
		expect(bucketIndexAt(0.5, 1, "slot")).toBe(0);
	});
});

describe("placeTooltip", () => {
	const chart = { width: 800, height: 240 };
	const box = { width: 200, height: 120 };

	it("centres the readout on the cursor when there is room", () => {
		const { left, top } = placeTooltip({ ...chart, x: 400, y: 200 }, box);
		expect(left).toBe(300); // 400 - 200/2
		expect(top).toBe(68); // 200 - 120 - 12
	});

	it("flips below the cursor rather than clipping against the top", () => {
		// The regression this replaced: a peak puts the cursor near y=0, and a fixed
		// translate(-100%) put the header row off the top of the chart.
		const { top } = placeTooltip({ ...chart, x: 400, y: 30 }, box);
		expect(top).toBe(42); // 30 + 12, below the cursor
		expect(top).toBeGreaterThanOrEqual(0);
	});

	it("keeps the readout inside the right edge on the last buckets", () => {
		const { left } = placeTooltip({ ...chart, x: 795, y: 200 }, box);
		expect(left + box.width).toBeLessThanOrEqual(chart.width);
	});

	it("keeps the readout inside the left edge on the first bucket", () => {
		const { left } = placeTooltip({ ...chart, x: 2, y: 200 }, box);
		expect(left).toBeGreaterThanOrEqual(0);
	});

	it("keeps the readout inside the bottom edge when it has to flip down", () => {
		const { top } = placeTooltip({ ...chart, x: 400, y: 10 }, { width: 200, height: 200 });
		expect(top + 200).toBeLessThanOrEqual(chart.height);
	});

	it("degrades to the top-left corner rather than negative offsets when the box cannot fit", () => {
		const { left, top } = placeTooltip({ ...chart, x: 400, y: 120 }, { width: 900, height: 300 });
		expect(left).toBeGreaterThanOrEqual(0);
		expect(top).toBeGreaterThanOrEqual(0);
	});
});

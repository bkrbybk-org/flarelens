import type { TrendBucket } from "./types";

// Same served/origin/bypass grouping as the analysis (cache-analysis.ts)
const SERVED = new Set(["hit", "stale", "updating", "revalidated"]);
const ORIGIN = new Set(["miss", "expired"]);

const GROUPS = [
	{ key: "served", label: "Served from cache", color: "#10b981" },
	{ key: "origin", label: "Origin fetch", color: "#f59e0b" },
	{ key: "bypass", label: "Bypass / dynamic", color: "#71717a" },
] as const;

function bucketGroups(bucket: TrendBucket): Record<string, number> {
	const out = { served: 0, origin: 0, bypass: 0 };
	for (const [status, n] of Object.entries(bucket.statuses)) {
		if (SERVED.has(status)) out.served += n;
		else if (ORIGIN.has(status)) out.origin += n;
		else out.bypass += n;
	}
	return out;
}

function bucketLabel(iso: string, daily: boolean): string {
	const d = new Date(iso);
	return daily
		? d.toLocaleDateString([], { month: "short", day: "numeric" })
		: d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TrendChart({ buckets, rangeHours }: { buckets: TrendBucket[]; rangeHours: number }) {
	const width = 920;
	const height = 200;
	const padding = 26;
	const gap = 2;
	const daily = rangeHours > 168;

	const grouped = buckets.map(bucketGroups);
	const max = Math.max(1, ...grouped.map((g) => g.served + g.origin + g.bypass));
	const barWidth = Math.max(4, (width - padding * 2 - gap * (buckets.length - 1)) / Math.max(buckets.length, 1));
	const innerHeight = height - padding * 2;

	return (
		<section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">Traffic trend</h2>
				<div className="flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400">
					{GROUPS.map((g) => (
						<span key={g.key} className="inline-flex items-center gap-1.5">
							<span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
							{g.label}
						</span>
					))}
				</div>
			</div>
			<svg className="h-52 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cache traffic trend">
				<line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="stroke-zinc-300 dark:stroke-zinc-700" />
				{buckets.map((bucket, i) => {
					const g = grouped[i];
					const total = g.served + g.origin + g.bypass;
					const x = padding + i * (barWidth + gap);
					const title = `${bucketLabel(bucket.t, daily)}: ${total.toLocaleString()} requests (${g.served.toLocaleString()} cached)`;
					if (!total) {
						return (
							<rect key={bucket.t} x={x} y={height - padding - 1} width={barWidth} height="1" className="fill-zinc-200 dark:fill-zinc-800">
								<title>{title}</title>
							</rect>
						);
					}
					let y = height - padding;
					return (
						<g key={bucket.t}>
							{GROUPS.map((group) => {
								const count = g[group.key];
								const segHeight = (innerHeight * count) / max;
								if (!segHeight) return null;
								y -= segHeight;
								return (
									<rect key={group.key} x={x} y={y} width={barWidth} height={segHeight} fill={group.color} rx="1">
										<title>{title}</title>
									</rect>
								);
							})}
						</g>
					);
				})}
				{buckets.length > 1 && [0, 0.5, 1].map((frac) => {
					const index = Math.min(buckets.length - 1, Math.round(frac * (buckets.length - 1)));
					const x = padding + index * (barWidth + gap) + barWidth / 2;
					const anchor = frac === 0 ? "start" : frac === 1 ? "end" : "middle";
					return (
						<text key={frac} x={x} y={height - 8} textAnchor={anchor} fontSize="11" className="fill-zinc-500 dark:fill-zinc-400">
							{bucketLabel(buckets[index].t, daily)}
						</text>
					);
				})}
			</svg>
		</section>
	);
}

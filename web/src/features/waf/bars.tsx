// Ported from cf-waf-rules-analyzer src/components/bars.jsx (Preact → React,
// theme conditionals → Tailwind dark: classes)

import { actionColors } from "../../lib/waf/constants";
import { chartActionFor } from "../../lib/waf/chart";
import { clampNumber, titleCase } from "../../lib/waf/format";

export function ActionMixBar({ actions, total }: { actions: Record<string, number>; total: number }) {
	const width = 150;
	const height = 10;
	let x = 0;
	const segments = Object.entries(actions)
		.sort((a, b) => b[1] - a[1])
		.map(([action, count]) => {
			const group = chartActionFor(action);
			const color = group ? group.color : "#71717a";
			const segWidth = total ? (count / total) * width : 0;
			const left = x;
			x += segWidth;
			return (
				<rect key={action} x={left} y="0" width={segWidth} height={height} fill={color}>
					<title>{`${titleCase(action)}: ${count.toLocaleString()}`}</title>
				</rect>
			);
		});
	return (
		<span className="block overflow-hidden rounded">
			<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Action mix">
				{segments}
			</svg>
		</span>
	);
}

export function ShareBar({ share }: { share: number }) {
	const width = 110;
	const height = 6;
	const fill = Math.max(2, Math.min(width, share * width));
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Share of ruleset">
			<rect x="0" y="0" width={width} height={height} rx="3" className="fill-zinc-200 dark:fill-zinc-700" />
			<rect x="0" y="0" width={fill} height={height} rx="3" className="fill-zinc-600 dark:fill-zinc-200" />
		</svg>
	);
}

const SPARK_BINS = 24;

export function Sparkline({ times, since, until }: { times: number[]; since: number; until: number }) {
	const width = 120;
	const height = 26;
	const span = until - since;
	if (!times?.length || span <= 0) return null;
	const counts = new Array<number>(SPARK_BINS).fill(0);
	for (const time of times) {
		counts[clampNumber(Math.floor(((time - since) / span) * SPARK_BINS), 0, SPARK_BINS - 1)] += 1;
	}
	const max = Math.max(1, ...counts);
	const step = width / (SPARK_BINS - 1);
	const points = counts.map((count, index) => {
		const px = index * step;
		const py = height - 2 - (count / max) * (height - 6);
		return `${px.toFixed(1)},${py.toFixed(1)}`;
	});
	const area = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Activity trend" className="block">
			<path d={area} fill="#f97316" fillOpacity="0.15" />
			<polyline points={points.join(" ")} fill="none" stroke="#f97316" strokeWidth="1.5" strokeLinejoin="round" />
		</svg>
	);
}

export function ActionBadges({ actions }: { actions: Record<string, number> }) {
	return (
		<>
			{Object.entries(actions)
				.sort((a, b) => b[1] - a[1])
				.map(([action, count]) => {
					const cls = actionColors[action] || "bg-zinc-700 text-white";
					return (
						<span key={action} className={`inline-flex items-center gap-1 rounded-full ${cls} px-2 py-1 text-xs font-semibold`}>
							<span>{titleCase(action)}</span>
							<span>{count.toLocaleString()}</span>
						</span>
					);
				})}
		</>
	);
}

export function RuleTypeBadge({ type }: { type: string }) {
	const cls =
		type === "managed"
			? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
			: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
	return <span className={`rounded-full ${cls} px-2 py-1 text-xs font-semibold`}>{titleCase(type)}</span>;
}

export function RuleLevelBadge({ level }: { level: string }) {
	const cls =
		level === "account"
			? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
			: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300";
	return <span className={`rounded-full ${cls} px-2 py-1 text-xs font-semibold`}>{titleCase(level)}</span>;
}

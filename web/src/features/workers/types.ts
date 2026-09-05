export const WORKER_METRICS = {
	requests: "Requests",
	errors: "Errors",
	subrequests: "Subrequests",
	cpu: "CPU P50",
} as const;

export type WorkerMetric = keyof typeof WORKER_METRICS;

export const WORKER_PRESETS = {
	"1h": { label: "1h", ms: 3_600_000 },
	"6h": { label: "6h", ms: 6 * 3_600_000 },
	"24h": { label: "24h", ms: 24 * 3_600_000 },
	"7d": { label: "7d", ms: 7 * 86_400_000 },
	"30d": { label: "30d", ms: 30 * 86_400_000 },
} as const;

export type WorkerPreset = keyof typeof WORKER_PRESETS;
export type Granularity = "hourly" | "daily";

export interface WorkerMetricRecord {
	dimensions: { scriptName: string } & Record<string, string>;
	sum: { requests: number; errors: number; subrequests: number };
	quantiles: { cpuTimeP50: number | null };
}

export interface WorkerMetricsResult {
	data: WorkerMetricRecord[];
	granularity: Granularity;
	timeDimension: string;
	truncated: boolean;
}

export interface WorkerTotals {
	requests: number;
	errors: number;
	subrequests: number;
	/** Mean of the per-bucket P50s, in microseconds; null when nothing reported CPU time. */
	cpuTimeP50: number | null;
}

/** The timestamp of a record, whichever time dimension the response used. */
export function recordTs(record: WorkerMetricRecord, timeDimension: string): string {
	return record.dimensions[timeDimension] ?? "";
}

export function emptyTotals(): WorkerTotals {
	return { requests: 0, errors: 0, subrequests: 0, cpuTimeP50: null };
}

/**
 * Sum a set of records.
 *
 * CPU is a P50 per bucket, so it cannot be summed — averaging the per-bucket medians is what
 * the upstream dashboard does, and it is the only honest option without the raw distribution.
 * Buckets that reported no CPU time are excluded rather than counted as zero.
 */
export function totalsOf(records: WorkerMetricRecord[]): WorkerTotals {
	const totals = emptyTotals();
	let cpuSum = 0;
	let cpuCount = 0;
	for (const record of records) {
		totals.requests += record.sum?.requests ?? 0;
		totals.errors += record.sum?.errors ?? 0;
		totals.subrequests += record.sum?.subrequests ?? 0;
		const cpu = record.quantiles?.cpuTimeP50;
		if (cpu) {
			cpuSum += cpu;
			cpuCount++;
		}
	}
	totals.cpuTimeP50 = cpuCount ? cpuSum / cpuCount : null;
	return totals;
}

export function metricValue(record: WorkerMetricRecord, metric: WorkerMetric): number {
	switch (metric) {
		case "requests":
			return record.sum?.requests ?? 0;
		case "errors":
			return record.sum?.errors ?? 0;
		case "subrequests":
			return record.sum?.subrequests ?? 0;
		case "cpu":
			// Microseconds upstream; charted in milliseconds.
			return record.quantiles?.cpuTimeP50 ? record.quantiles.cpuTimeP50 / 1000 : 0;
	}
}

export function errorRate(totals: WorkerTotals): number {
	return totals.requests > 0 ? (totals.errors / totals.requests) * 100 : 0;
}

/** Compact counts: 1.2K, 3.4M. */
export function formatCount(value: number | null): string {
	if (value === null) return "—";
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
	return value.toLocaleString();
}

/** Microseconds to a readable millisecond figure. */
export function formatCpu(microseconds: number | null): string {
	if (!microseconds) return "—";
	const ms = microseconds / 1000;
	return ms < 1 ? "<1 ms" : `${ms.toFixed(1)} ms`;
}

export function bucketLabel(iso: string, granularity: Granularity): string {
	const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
	if (Number.isNaN(date.getTime())) return iso;
	if (granularity === "daily") {
		return date.toLocaleDateString([], { month: "short", day: "numeric" });
	}
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})}`;
}

/** Stable per-worker colour: same worker keeps its colour across metric and range changes. */
export const WORKER_COLORS = [
	"#f6821f", "#3b82f6", "#22c55e", "#a855f7",
	"#ef4444", "#14b8a6", "#f59e0b", "#ec4899",
	"#6366f1", "#84cc16", "#06b6d4", "#fb923c",
];

export function workerColor(name: string, all: string[]): string {
	const index = all.indexOf(name);
	return WORKER_COLORS[(index >= 0 ? index : 0) % WORKER_COLORS.length];
}

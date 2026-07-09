export function SkeletonRows({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_, r) => (
				<tr key={r} className="border-b border-zinc-100 dark:border-zinc-800/60">
					{Array.from({ length: cols }, (_, c) => (
						<td key={c} className="px-4 py-3.5">
							<div
								className="h-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
								style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%` }}
							/>
						</td>
					))}
				</tr>
			))}
		</>
	);
}

export function SkeletonCards({ count = 5 }: { count?: number }) {
	return (
		<div className="space-y-3">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="animate-pulse rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
					<div className="mb-3 h-4 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
					<div className="mb-2 h-3 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800" />
					<div className="h-3 w-1/3 rounded bg-zinc-200 dark:bg-zinc-800" />
				</div>
			))}
		</div>
	);
}

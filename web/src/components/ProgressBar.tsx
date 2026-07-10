export function ProgressBar({ percent }: { percent: number }) {
	return (
		<div
			className="overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
			role="progressbar"
			aria-valuenow={Math.round(percent)}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			<div className="h-1.5 rounded-full bg-cf transition-[width] duration-150" style={{ width: `${percent}%` }} />
		</div>
	);
}

import { useEffect, useRef, useState } from "react";
import type { CfApp, CfPolicy } from "../../types";
import { formatLocalDateTime, resolvePolicy, type RuleContext } from "../../lib/rules";
import { CheckIcon, CopyIcon, XIcon } from "../../components/Icons";
import { DecisionBadge, ErrorBadge, Tag } from "./PolicyChip";
import { RuleList } from "./RuleList";

interface DetailDrawerProps {
	app: CfApp | null;
	onClose: () => void;
	ctx: RuleContext;
	reusableMap: Record<string, CfPolicy>;
}

function CopyJsonButton({ value }: { value: unknown }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={async () => {
				await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
		>
			{copied ? <CheckIcon size={13} className="text-emerald-500" /> : <CopyIcon size={13} />}
			{copied ? "Copied" : "Copy JSON"}
		</button>
	);
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-3 text-sm">
			<span className="w-28 shrink-0 text-zinc-500 dark:text-zinc-400">{label}</span>
			<span className="min-w-0 flex-1 break-words">{children}</span>
		</div>
	);
}

export function DetailDrawer({ app, onClose, ctx, reusableMap }: DetailDrawerProps) {
	const closeBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!app) return;
		closeBtnRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [app, onClose]);

	if (!app) return null;

	const domains = app.self_hosted_domains || [];

	return (
		<div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Details for ${app.name || app.id}`}>
			<button type="button" aria-label="Close details" className="absolute inset-0 bg-black/50" onClick={onClose} />
			<div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[28rem] md:rounded-none dark:bg-zinc-900">
				<div className="sticky top-0 flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
					<div className="min-w-0">
						<h2 className="truncate text-base font-semibold">{app.name || "Unnamed Application"}</h2>
						<p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{app.domain || app.id}</p>
					</div>
					<button
						ref={closeBtnRef}
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
					>
						<XIcon size={18} />
					</button>
				</div>

				<div className="space-y-6 px-5 py-5">
					<section className="space-y-2">
						{app.type != null && <MetaRow label="Type">{String(app.type)}</MetaRow>}
						{domains.length > 0 && (
							<MetaRow label="Domains">
								<span className="flex flex-wrap gap-1">{domains.map((d) => <Tag key={d} label={d} />)}</span>
							</MetaRow>
						)}
						{(app.tags?.length ?? 0) > 0 && (
							<MetaRow label="Tags">
								<span className="flex flex-wrap gap-1">{app.tags!.map((t) => <Tag key={t} label={t} />)}</span>
							</MetaRow>
						)}
						{(app.allowed_idps?.length ?? 0) > 0 && (
							<MetaRow label="IdPs">
								<span className="flex flex-wrap gap-1">
									{app.allowed_idps!.map((id) => <Tag key={id} label={ctx.idpName(id)} />)}
								</span>
							</MetaRow>
						)}
						{app.created_at != null && <MetaRow label="Created">{formatLocalDateTime(app.created_at)}</MetaRow>}
						{app.updated_at != null && <MetaRow label="Updated">{formatLocalDateTime(app.updated_at)}</MetaRow>}
					</section>

					<section>
						<div className="mb-3 flex items-center justify-between">
							<h3 className="text-sm font-semibold">Policies ({app.policies.length})</h3>
							<CopyJsonButton value={app} />
						</div>

						{app.policies_error && (
							<div className="mb-3"><ErrorBadge label="Policies unavailable — fetch failed" /></div>
						)}

						<div className="space-y-4">
							{app.policies.map((raw) => {
								const policy = resolvePolicy(raw, reusableMap);
								return (
									<div key={policy.id} className="rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-700/60">
										<div className="mb-3 flex items-center justify-between gap-2">
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate text-sm font-medium">{policy.name || "Unnamed Policy"}</span>
												{policy.reusable === true && <Tag label="reusable" />}
											</span>
											<DecisionBadge decision={policy.decision || "unknown"} />
										</div>
										<RuleList policy={policy} ctx={ctx} />
										<details className="mt-3">
											<summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
												Raw JSON
											</summary>
											<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950">
												{JSON.stringify(policy, null, 2)}
											</pre>
										</details>
									</div>
								);
							})}
							{app.policies.length === 0 && !app.policies_error && (
								<p className="text-sm text-zinc-500 dark:text-zinc-400">No policies attached.</p>
							)}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}

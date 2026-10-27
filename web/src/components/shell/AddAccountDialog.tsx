import { useRef, useState, type FormEvent } from "react";
import { fetchAccounts } from "../../api/client";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { ALERT_ERROR, BTN_PRIMARY, BTN_SECONDARY, INPUT, MUTED } from "../../lib/ui";
import type { ExtraAccount } from "../../lib/extraAccounts";
import type { CfAccount } from "../../types";

interface AddAccountDialogProps {
	/** Accounts already in the switcher; offered again only to refresh their token. */
	knownIds: Set<string>;
	onCancel: () => void;
	onAdd: (accounts: ExtraAccount[]) => void;
}

/**
 * Paste a read-only API token, see which accounts it reaches, add the ones to view. The token is
 * used for one lookup here and then kept only in this tab's session storage (lib/extraAccounts.ts).
 */
export function AddAccountDialog({ knownIds, onCancel, onAdd }: AddAccountDialogProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	useFocusTrap(containerRef, true, onCancel);
	const [token, setToken] = useState("");
	const [found, setFound] = useState<CfAccount[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function lookUp(e: FormEvent) {
		e.preventDefault();
		const trimmed = token.trim();
		if (!trimmed) return;
		setBusy(true);
		setError("");
		try {
			const accounts = await fetchAccounts(trimmed);
			if (accounts.length === 0) {
				setError("This token can't see any account. It needs at least Account Settings: Read.");
				setFound(null);
			} else {
				setFound(accounts);
				// Preselect the accounts that are new; ones already listed stay a deliberate choice.
				setChosen(new Set(accounts.filter((a) => !knownIds.has(a.id)).map((a) => a.id)));
			}
		} catch (err) {
			setError(err instanceof Error ? `Cloudflare refused this token: ${err.message}` : "Cloudflare refused this token.");
			setFound(null);
		} finally {
			setBusy(false);
		}
	}

	function add() {
		const trimmed = token.trim();
		onAdd((found ?? []).filter((a) => chosen.has(a.id)).map((a) => ({ id: a.id, name: a.name || a.id, token: trimmed })));
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button type="button" aria-label="Close dialog" className="absolute inset-0 bg-black/50" onClick={onCancel} />
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="add-account-title"
				className="relative w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
			>
				<h2 id="add-account-title" className="mb-1 text-sm font-semibold">Add an account</h2>
				<p className={`mb-3 text-xs ${MUTED}`}>
					Paste a read-only Cloudflare API token for the account. It stays in this browser tab only — never saved to disk or
					on the server — and is forgotten when the tab closes or you disconnect.
				</p>
				<form onSubmit={lookUp} className="flex gap-2">
					<label htmlFor="add-account-token" className="sr-only">API token</label>
					<input
						id="add-account-token"
						type="password"
						autoComplete="off"
						autoFocus
						value={token}
						onChange={(e) => {
							setToken(e.target.value);
							setFound(null);
						}}
						placeholder="API token"
						className={`min-w-0 flex-1 ${INPUT}`}
					/>
					<button type="submit" className={BTN_SECONDARY} disabled={busy || !token.trim()}>
						{busy ? "Checking…" : "Find accounts"}
					</button>
				</form>

				{error && (
					<div role="alert" className={`mt-3 ${ALERT_ERROR}`}>
						{error}
					</div>
				)}

				{found && (
					<fieldset className="mt-3">
						<legend className="mb-1 text-xs font-medium">This token can see:</legend>
						<ul className="max-h-60 space-y-1 overflow-auto">
							{found.map((a) => (
								<li key={a.id}>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={chosen.has(a.id)}
											onChange={(e) =>
												setChosen((prev) => {
													const next = new Set(prev);
													if (e.target.checked) next.add(a.id);
													else next.delete(a.id);
													return next;
												})
											}
										/>
										<span className="truncate">{a.name || a.id}</span>
										{knownIds.has(a.id) && <span className={`text-xs ${MUTED}`}>already listed</span>}
									</label>
								</li>
							))}
						</ul>
					</fieldset>
				)}

				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onCancel} className={BTN_SECONDARY}>Cancel</button>
					<button type="button" onClick={add} className={BTN_PRIMARY} disabled={!found || chosen.size === 0}>
						Add {chosen.size > 0 ? chosen.size : ""} {chosen.size === 1 ? "account" : "accounts"}
					</button>
				</div>
			</div>
		</div>
	);
}

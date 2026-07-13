import { useState, type FormEvent } from "react";
import { fetchAccounts, fetchZeroTrustData } from "../../api/client";
import type { CfAccount } from "../../types";
import type { Session } from "../../hooks/useSession";
import { EyeIcon, EyeOffIcon, ShieldIcon } from "../Icons";

interface ConnectPageProps {
	onConnect: (session: Session) => void;
}

export function ConnectPage({ onConnect }: ConnectPageProps) {
	const [token, setToken] = useState("");
	const [accountIdInput, setAccountIdInput] = useState("");
	const [showToken, setShowToken] = useState(false);
	const [accounts, setAccounts] = useState<CfAccount[]>([]);
	const [selectedAccount, setSelectedAccount] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		const trimmedToken = token.trim();
		if (!trimmedToken) {
			setError("API Token is required");
			return;
		}

		setBusy(true);
		setError("");
		try {
			let accountId = selectedAccount || accountIdInput.trim();
			let accountName = accountId;

			if (!accountId) {
				const found = await fetchAccounts(trimmedToken);
				if (found.length === 0) {
					throw new Error('No accounts found for this API token. Ensure it has the "Account Settings: Read" permission.');
				}
				if (found.length > 1) {
					setAccounts(found);
					setBusy(false);
					return;
				}
				accountId = found[0].id;
				accountName = found[0].name || accountId;
			} else {
				const match = accounts.find((a) => a.id === accountId);
				if (match) {
					accountName = match.name || accountId;
				}
			}

			// Validate the token + account before committing the session
			await fetchZeroTrustData(trimmedToken, accountId);
			onConnect({ token: trimmedToken, accountId, accountName });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to connect");
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-dvh items-center justify-center p-4">
			<div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
				<div className="mb-6 flex flex-col items-center text-center">
					<span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-cf/15 text-cf">
						<ShieldIcon size={26} />
					</span>
					<h1 className="text-lg font-semibold">Flarelens</h1>
					<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
						Connect your Cloudflare API token to explore Access policies, WAF activity, and cache rules.
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label htmlFor="api-token" className="mb-1.5 block text-sm font-medium">Cloudflare API Token</label>
						<div className="relative">
							<input
								id="api-token"
								type={showToken ? "text" : "password"}
								required
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder="Paste your API token…"
								className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 pr-10 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700"
							/>
							<button
								type="button"
								onClick={() => setShowToken((v) => !v)}
								aria-label={showToken ? "Hide token" : "Show token"}
								className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
							>
								{showToken ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
							</button>
						</div>
						<p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
							Recommended scopes: <strong>Account Settings: Read</strong>, <strong>Access: Read</strong>,{" "}
							<strong>Zone: Read</strong>, <strong>Cache Rules: Read</strong>, <strong>Analytics: Read</strong>,{" "}
							<strong>Zone WAF: Read</strong> + <strong>Account WAF: Read</strong>. Sections degrade individually
							when a scope is missing.
						</p>
					</div>

					{accounts.length > 1 ? (
						<div>
							<label htmlFor="account-select" className="mb-1.5 block text-sm font-medium">Select Account</label>
							<select
								id="account-select"
								required
								value={selectedAccount}
								onChange={(e) => setSelectedAccount(e.target.value)}
								className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
							>
								<option value="">-- Select Account --</option>
								{accounts.map((a) => (
									<option key={a.id} value={a.id}>{a.name || a.id}</option>
								))}
							</select>
						</div>
					) : (
						<div>
							<label htmlFor="account-id" className="mb-1.5 block text-sm font-medium">
								Account ID <span className="font-normal text-zinc-400">(optional)</span>
							</label>
							<input
								id="account-id"
								type="text"
								value={accountIdInput}
								onChange={(e) => setAccountIdInput(e.target.value)}
								placeholder="Auto-discovered if left blank"
								className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700"
							/>
						</div>
					)}

					{error && (
						<div role="alert" className="rounded-lg border border-red-300/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
							{error}
						</div>
					)}

					<button
						type="submit"
						disabled={busy}
						className="w-full rounded-lg bg-cf px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-cf-hover disabled:opacity-60"
					>
						{busy ? "Connecting…" : "Connect"}
					</button>
				</form>
			</div>
		</div>
	);
}

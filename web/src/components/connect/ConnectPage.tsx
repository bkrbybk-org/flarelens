import { useState, type FormEvent } from "react";
import { ALERT_ERROR } from "../../lib/ui";
import { ApiError, fetchAccounts, fetchZeroTrustData } from "../../api/client";
import type { CfAccount } from "../../types";
import type { Session } from "../../hooks/useSession";
import { CheckIcon, EyeIcon, EyeOffIcon, RefreshIcon, ShieldIcon, XIcon } from "../Icons";

interface ConnectPageProps {
	onConnect: (session: Session) => void;
	/** Server mode with more than one allowlisted account: the operator picks, no token needed. */
	serverAccounts?: { id: string; name: string }[];
	serverError?: string;
	onPickServerAccount?: (account: { id: string; name: string }) => void;
}

type CheckStatus = "idle" | "checking" | "granted" | "missing" | "skipped";

interface RequiredCheck {
	key: "account" | "access";
	label: string;
	description: string;
	status: CheckStatus;
	detail?: string;
}

const INITIAL_REQUIRED: RequiredCheck[] = [
	{
		key: "account",
		label: "Account Settings: Read",
		description: "Lists the accounts your token can access.",
		status: "idle",
	},
	{
		key: "access",
		label: "Access: Read",
		description: "Applications, policies, and identity providers.",
		status: "idle",
	},
];

const OPTIONAL_PERMISSIONS = [
	{ label: "Access: Organizations, Identity Providers, and Groups", description: "Resolves group names inside policies and populates the Access Groups section." },
	{ label: "Zone: Read", description: "Lists zones for the zone picker in WAF Analytics, Cache Rules and AI Security." },
	{ label: "Account WAF: Read", description: "Account-wide WAF rulesets in WAF Analytics." },
	{ label: "Zone WAF: Read", description: "Zone-level WAF rulesets in WAF Analytics." },
	{ label: "Cache Rules: Read", description: "Cache Rules section." },
	{ label: "Zone Analytics: Read", description: "Traffic and hit-ratio data in Cache Rules, and the request/detection telemetry behind AI Security." },
	// AI Security reads the firewallForAi* fields on httpRequestsAdaptive, which sit behind the
	// zone-scoped analytics permissions rather than a permission of their own. Called out so a
	// token that opens every other section but returns nothing here has a stated reason.
	{
		label: "Analytics: Read",
		description:
			"Prompt injection, PII and topic detections in AI Security, and the account-scoped GraphQL datasets behind Access Usage, Gateway Usage, Workers Analytics, Workers AI and Cost & Usage. Without it those sections load empty.",
	},
	{
		label: "Cloudflare Tunnel: Read",
		description:
			"Tunnel names, status, ingress rules and private routes in the Tunnel Map. Cloudflare returns an empty list rather than a 403 when this is missing, so the page states the ambiguity instead of showing a blank map.",
	},
	{
		label: "Workers Scripts: Read",
		description:
			"Adds workers with no traffic in the window to the Workers Analytics filter, and lets the Tunnel Map identify an Access application served by a Worker rather than reporting it as having no route. Both degrade rather than fail without it.",
	},
	{ label: "SSL and Certificates: Read", description: "Certificate expiry in Zone Health." },
] as const;

function StatusBadge({ status }: { status: CheckStatus }) {
	if (status === "checking") {
		return <RefreshIcon size={14} className="shrink-0 animate-spin text-zinc-500 dark:text-zinc-400" />;
	}
	if (status === "granted") {
		return <CheckIcon size={14} className="shrink-0 text-emerald-500" />;
	}
	if (status === "missing") {
		return <XIcon size={14} className="shrink-0 text-red-500" />;
	}
	// idle / skipped: not yet evaluated
	return <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />;
}

export function ConnectPage({ onConnect, serverAccounts = [], serverError = "", onPickServerAccount }: ConnectPageProps) {
	const [token, setToken] = useState("");
	const [accountIdInput, setAccountIdInput] = useState("");
	const [showToken, setShowToken] = useState(false);
	const [accounts, setAccounts] = useState<CfAccount[]>([]);
	const [selectedAccount, setSelectedAccount] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [required, setRequired] = useState<RequiredCheck[]>(INITIAL_REQUIRED);

	function setCheck(key: RequiredCheck["key"], status: CheckStatus, detail?: string) {
		setRequired((prev) => prev.map((c) => (c.key === key ? { ...c, status, detail } : c)));
	}

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		const trimmedToken = token.trim();
		if (!trimmedToken) {
			setError("API Token is required");
			return;
		}

		setBusy(true);
		setError("");
		setRequired(INITIAL_REQUIRED);

		try {
			let accountId = selectedAccount || accountIdInput.trim();
			let accountName = accountId;

			if (!accountId) {
				setCheck("account", "checking");
				let found: CfAccount[];
				try {
					found = await fetchAccounts(trimmedToken);
				} catch (err) {
					setCheck("account", "missing", err instanceof Error ? err.message : "Request failed");
					throw err;
				}
				setCheck("account", "granted");
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
				setCheck("account", "skipped", "Skipped — using the account ID you entered directly.");
				const match = accounts.find((a) => a.id === accountId);
				if (match) {
					accountName = match.name || accountId;
				}
			}

			// Validate the token + account before committing the session
			setCheck("access", "checking");
			try {
				await fetchZeroTrustData(trimmedToken, accountId);
			} catch (err) {
				setCheck("access", "missing", err instanceof Error ? err.message : "Request failed");
				throw err;
			}
			setCheck("access", "granted");

			onConnect({ token: trimmedToken, accountId, accountName, mode: "byot" });
		} catch (err) {
			if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
				setError(`${err.message} — check the token's permissions below.`);
			} else {
				setError(err instanceof Error ? err.message : "Failed to connect");
			}
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

				{serverAccounts.length > 0 && onPickServerAccount ? (
					<div className="space-y-3">
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Signed in through Cloudflare Access. Choose an account to continue.
						</p>
						{serverAccounts.map((account) => (
							<button
								key={account.id}
								type="button"
								onClick={() => onPickServerAccount(account)}
								className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-left text-sm transition hover:border-cf hover:bg-cf/5 dark:border-zinc-700"
							>
								<div className="font-medium">{account.name}</div>
								<div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{account.id}</div>
							</button>
						))}
					</div>
				) : (
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
								className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
							>
								{showToken ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
							</button>
						</div>
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
								Account ID <span className="font-normal text-zinc-500 dark:text-zinc-400">(optional)</span>
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
						<div role="alert" className={ALERT_ERROR}>
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
				)}

				{serverError && (
					<div role="alert" className={`mt-4 ${ALERT_ERROR}`}>
						{serverError}
					</div>
				)}

				<div className="mt-6 space-y-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
					<div>
						<h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							Required permissions
						</h2>
						<ul className="space-y-2">
							{required.map((check) => (
								<li key={check.key} className="flex gap-2 text-sm">
									<StatusBadge status={check.status} />
									<div className="min-w-0">
										<div className="font-medium">{check.label}</div>
										<div className="text-xs text-zinc-500 dark:text-zinc-400">{check.description}</div>
										{check.detail && check.status !== "skipped" && (
											<div className={`mt-0.5 text-xs ${check.status === "missing" ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}`}>
												{check.detail}
											</div>
										)}
									</div>
								</li>
							))}
						</ul>
					</div>

					<div>
						<h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							Optional permissions
						</h2>
						<ul className="space-y-2">
							{OPTIONAL_PERMISSIONS.map((perm) => (
								<li key={perm.label} className="flex gap-2 text-sm">
									<span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
									<div className="min-w-0">
										<div className="font-medium">{perm.label}</div>
										<div className="text-xs text-zinc-500 dark:text-zinc-400">{perm.description}</div>
									</div>
								</li>
							))}
						</ul>
						<p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
							Missing an optional scope just narrows that section — checked individually when you open it.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

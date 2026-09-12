import { useState } from "react";
import { FOCUS_RING } from "../../lib/ui";
import { MatchedDataError, decryptMatchedData } from "./matchedData";

/**
 * The encrypted prompt for one flagged request.
 *
 * Decryption is per-row and on demand rather than automatic for the whole table: reading a
 * prompt means reading whatever the user typed, including the PII that got it flagged, so it
 * happens when an operator asks for that specific row — not as a side effect of opening a page.
 */
export function PromptPayload({ ciphertext, privateKey }: { ciphertext: string; privateKey: string }) {
	const [plaintext, setPlaintext] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (!privateKey) {
		return (
			<span className="text-zinc-500 dark:text-zinc-400">
				Encrypted. Enter the zone's payload-logging private key above to read it.
			</span>
		);
	}

	if (plaintext !== null) {
		return (
			<div>
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950">
					{plaintext}
				</pre>
				<button
					type="button"
					onClick={() => setPlaintext(null)}
					className="mt-1 text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					Hide prompt
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<button
				type="button"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setError(null);
					try {
						setPlaintext(await decryptMatchedData(privateKey, ciphertext));
					} catch (err) {
						setError(err instanceof MatchedDataError ? err.message : "Decryption failed.");
					} finally {
						setBusy(false);
					}
				}}
				className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				{busy ? "Decrypting…" : "Decrypt prompt"}
			</button>
			{error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
		</div>
	);
}

/**
 * Key entry for payload decryption.
 *
 * The key lives in component state and nowhere else: not localStorage, not sessionStorage, and
 * never in a request to the Worker, which only ever sees ciphertext. It is therefore gone on
 * reload or navigation away, which is the intended lifetime — the ability to read prompts should
 * expire with the sitting, not persist in the browser.
 */
export function DecryptKeyPanel({
	privateKey,
	onChange,
}: {
	privateKey: string;
	onChange: (next: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const loaded = Boolean(privateKey);

	return (
		<form
			className="mb-3 rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-800"
			autoComplete="off"
			onSubmit={(e) => {
				e.preventDefault();
				const next = draft.trim();
				if (next) onChange(next);
			}}
		>
			<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
				Decrypt prompts (browser only)
			</h3>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor="payload-key" className="sr-only">
					Payload-logging private key (base64)
				</label>
				<input
					id="payload-key"
					type="password"
					value={loaded ? "" : draft}
					disabled={loaded}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Payload-logging private key (base64)"
					autoComplete="off"
					spellCheck={false}
					className={`min-w-[20rem] flex-1 rounded-md border border-zinc-300 bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none transition focus:border-cf disabled:opacity-50 dark:border-zinc-700 ${FOCUS_RING}`}
				/>
				<button
					type="submit"
					disabled={loaded || !draft.trim()}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					Decrypt
				</button>
				<button
					type="button"
					disabled={!loaded && !draft}
					onClick={() => {
						onChange("");
						setDraft("");
					}}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
				>
					Forget key
				</button>
				<span
					className={`rounded-md px-2 py-1 text-xs font-medium ${
						loaded
							? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
							: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"
					}`}
				>
					{loaded ? "Key held in memory" : "Key not entered"}
				</span>
			</div>
			<p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
				Your private key is used in this browser only — never sent to the server, never stored, and gone when this
				page reloads, so it has to be entered again each session. Decrypted prompts contain the data that was
				flagged, including PII; close the tab or select <strong>Forget key</strong> when finished.
			</p>
		</form>
	);
}

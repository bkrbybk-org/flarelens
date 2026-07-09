import { useMemo, useState } from "react";
import { compileTriState } from "../../lib/expr";
import type { CacheRule } from "./types";

export interface TestResults {
	// ruleId → matched | no-match | unknown
	outcomes: Record<string, "matched" | "no-match" | "unknown">;
	winnerId: string | null;
	unknownFields: Record<string, string[]>;
}

interface UrlTesterProps {
	rules: CacheRule[];
	hosts: string[];
	onResults: (results: TestResults | null) => void;
}

// Client-side port of the original /api/test-uri route: pure tri-state
// expression evaluation against the rules already in memory — no credentials.
export function UrlTester({ rules, hosts, onResults }: UrlTesterProps) {
	const [input, setInput] = useState("");
	const [host, setHost] = useState(hosts[0] || "");
	const [summary, setSummary] = useState<string | null>(null);

	const compiled = useMemo(
		() => rules.map((rule) => ({ rule, compiled: compileTriState(rule.expression) })),
		[rules],
	);

	function runTest() {
		const trimmed = input.trim();
		if (!trimmed) {
			setSummary(null);
			onResults(null);
			return;
		}
		let path = trimmed;
		let testHost = host;
		try {
			if (/^https?:\/\//i.test(trimmed)) {
				const url = new URL(trimmed);
				testHost = url.hostname;
				path = url.pathname + url.search;
			} else if (!trimmed.startsWith("/")) {
				path = "/" + trimmed;
			}
		} catch {
			path = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
		}

		const outcomes: TestResults["outcomes"] = {};
		const unknownFields: TestResults["unknownFields"] = {};
		let winnerId: string | null = null;
		for (const { rule, compiled: c } of compiled) {
			const value = c.evaluate({ path, host: testHost });
			outcomes[rule.id] = value === "unknown" ? "unknown" : value ? "matched" : "no-match";
			if (c.unknownFields.length) unknownFields[rule.id] = c.unknownFields;
			// Cache Rules semantics: last matching enabled rule wins
			if (value === true && rule.enabled) winnerId = rule.id;
		}
		const matchedCount = Object.values(outcomes).filter((o) => o === "matched").length;
		const unknownCount = Object.values(outcomes).filter((o) => o === "unknown").length;
		setSummary(
			`${matchedCount} rule${matchedCount === 1 ? "" : "s"} matched ${testHost}${path}` +
			(unknownCount ? ` (${unknownCount} unknown — expressions use fields beyond path/host)` : "") +
			(winnerId ? "" : matchedCount ? " — no enabled winner" : ""),
		);
		onResults({ outcomes, winnerId, unknownFields });
	}

	return (
		<section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
			<h2 className="mb-2 text-sm font-semibold">URL tester</h2>
			<p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
				Enter a path or full URL to see which rules match — the last matching active rule wins. Evaluated locally, nothing is sent to Cloudflare.
			</p>
			<div className="flex flex-wrap gap-2">
				{hosts.length > 0 && (
					<select
						value={host}
						onChange={(e) => setHost(e.target.value)}
						aria-label="Host for bare paths"
						className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900"
					>
						{hosts.map((h) => <option key={h} value={h}>{h}</option>)}
					</select>
				)}
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && runTest()}
					placeholder="/images/logo.png or https://example.com/api/data?x=1"
					className="min-w-0 flex-1 basis-64 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-cf focus:ring-2 focus:ring-cf/30 dark:border-zinc-700 dark:bg-zinc-900"
				/>
				<button
					type="button"
					onClick={runTest}
					className="rounded-lg bg-cf px-4 py-2 text-sm font-medium text-white transition hover:bg-cf-hover"
				>
					Test
				</button>
			</div>
			{summary && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{summary}</p>}
		</section>
	);
}

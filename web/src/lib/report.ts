// Builds the Findings page's "Report" export: a single self-contained HTML file, safe to hand to
// a client, print to PDF, or open a year from now with nothing but a browser. No scripts, no
// external resources (fonts, images, stylesheets) — everything is inline, so the file works
// exactly the same offline as it did the day it was generated.
import type { Finding, FindingSource, Severity } from "./findings";

/**
 * Every finding's title/detail and every source's error reason ultimately comes from data this
 * app does not control — a WAF rule name, a DNS record name, an upstream error message. None of
 * it is trusted to be free of `<`, `&`, or quote characters, so every interpolated string in the
 * report goes through this first. There is exactly one place in this file that writes `innerHTML`
 * -shaped text without calling it.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export type SourceCoverageStatus = "checked" | "loading" | "not-checked" | "not-opened";

export interface SourceCoverage {
	source: FindingSource;
	label: string;
	status: SourceCoverageStatus;
	/** Finding count, when status is "checked". */
	count?: number;
	/** Why the source could not be checked, when status is "not-checked" or "not-opened". */
	reason?: string;
}

export interface ReportInput {
	accountName: string;
	/** ISO timestamp; rendered with the viewer's locale so the report reads naturally wherever it's opened. */
	generatedAt: string;
	findings: Finding[];
	coverage: SourceCoverage[];
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function severityTotals(findings: Finding[]): Record<Severity, number> {
	const totals: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
	for (const f of findings) totals[f.severity]++;
	return totals;
}

function findingsTable(findings: Finding[]): string {
	if (findings.length === 0) {
		return `<p class="empty">No findings in this section.</p>`;
	}
	const rows = [...findings]
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
		.map(
			(f) => `<tr>
				<td><span class="pill pill-${f.severity}">${SEVERITY_LABEL[f.severity]}</span></td>
				<td>${escapeHtml(f.title)}</td>
				<td>${escapeHtml(f.detail)}</td>
				<td class="mono">${escapeHtml(f.href.replace(/^#\/?/, ""))}</td>
			</tr>`,
		)
		.join("\n");
	return `<table>
		<thead><tr><th>Severity</th><th>Finding</th><th>Detail</th><th>Affected resource</th></tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

function coverageRow(c: SourceCoverage): string {
	const statusText =
		c.status === "checked"
			? `Checked (${c.count ?? 0} finding${c.count === 1 ? "" : "s"})`
			: c.status === "loading"
				? "Loading…"
				: c.status === "not-opened"
					? `Not opened${c.reason ? ` — ${escapeHtml(c.reason)}` : ""}`
					: `Not checked${c.reason ? ` — ${escapeHtml(c.reason)}` : ""}`;
	return `<tr><td>${escapeHtml(c.label)}</td><td class="status-${c.status}">${statusText}</td></tr>`;
}

function notCheckedList(coverage: SourceCoverage[]): string {
	const uncovered = coverage.filter((c) => c.status === "not-checked" || c.status === "not-opened" || c.status === "loading");
	if (uncovered.length === 0) {
		return `<p class="empty">Every source was checked.</p>`;
	}
	return `<ul>${uncovered
		.map((c) => {
			const why = c.reason ?? (c.status === "loading" ? "Still loading when this report was generated." : "Not opened.");
			return `<li><strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(why)}</li>`;
		})
		.join("\n")}</ul>`;
}

function formatGeneratedAt(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return escapeHtml(iso);
	return escapeHtml(
		d.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }),
	);
}

/**
 * Pure HTML string builder — no DOM, no download, so it is unit-testable without jsdom. The
 * Findings page hands the result to a Blob download, the same pattern `downloadCsv` uses.
 */
export function buildReportHtml(input: ReportInput): string {
	const totals = severityTotals(input.findings);
	const bySource = new Map<FindingSource, Finding[]>();
	for (const f of input.findings) {
		const list = bySource.get(f.source) ?? [];
		list.push(f);
		bySource.set(f.source, list);
	}

	const sections = input.coverage
		.filter((c) => c.status === "checked")
		.map((c) => {
			const findings = bySource.get(c.source) ?? [];
			return `<section class="source-section">
				<h2>${escapeHtml(c.label)}</h2>
				${findingsTable(findings)}
			</section>`;
		})
		.join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.accountName)} — Flarelens security posture report</title>
<style>
	:root {
		--fg: #18181b; --muted: #52525b; --border: #e4e4e7; --bg: #ffffff; --card: #fafafa;
		--high: #dc2626; --medium: #b45309; --low: #0369a1;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 32px; background: var(--bg); color: var(--fg);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		font-size: 14px; line-height: 1.5;
	}
	h1 { font-size: 22px; margin: 0 0 4px; }
	h2 { font-size: 16px; margin: 32px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
	.meta { color: var(--muted); margin: 0 0 24px; }
	.totals { display: flex; gap: 16px; margin: 16px 0 24px; }
	.total-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; background: var(--card); min-width: 100px; }
	.total-card .n { font-size: 22px; font-weight: 700; }
	.total-card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
	table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
	th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
	th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
	.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; }
	.pill-high { background: var(--high); }
	.pill-medium { background: var(--medium); }
	.pill-low { background: var(--low); }
	.status-checked { color: #15803d; }
	.status-not-checked, .status-not-opened { color: var(--high); }
	.status-loading { color: var(--muted); }
	.empty { color: var(--muted); font-style: italic; }
	ul { margin: 8px 0; padding-left: 20px; }
	section.source-section { break-inside: avoid; }
	@media print {
		body { padding: 0; }
		@page { size: A4; margin: 16mm; }
		h2 { break-after: avoid; }
		tr, .total-card { break-inside: avoid; }
	}
</style>
</head>
<body>
	<h1>${escapeHtml(input.accountName)} — Security posture report</h1>
	<p class="meta">Generated by Flarelens on ${formatGeneratedAt(input.generatedAt)}.</p>

	<div class="totals">
		<div class="total-card"><div class="n">${totals.high}</div><div class="label">High</div></div>
		<div class="total-card"><div class="n">${totals.medium}</div><div class="label">Medium</div></div>
		<div class="total-card"><div class="n">${totals.low}</div><div class="label">Low</div></div>
	</div>

	<h2>Coverage</h2>
	<table>
		<thead><tr><th>Source</th><th>Status</th></tr></thead>
		<tbody>${input.coverage.map(coverageRow).join("\n")}</tbody>
	</table>

	${sections}

	<h2>What was not checked</h2>
	${notCheckedList(input.coverage)}
</body>
</html>
`;
}

/** Same Blob + download pattern as csv.ts's downloadCsv. */
export function downloadHtml(filename: string, html: string): void {
	const blob = new Blob([html], { type: "text/html;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

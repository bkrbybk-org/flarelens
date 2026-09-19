import { describe, expect, it } from "vitest";
import { buildReportHtml, escapeHtml, type ReportInput, type SourceCoverage } from "../web/src/lib/report";
import type { Finding } from "../web/src/lib/findings";

describe("escapeHtml", () => {
	it("escapes the five characters that matter for HTML text and attributes", () => {
		expect(escapeHtml(`<script>alert("hi") & 'bye'</script>`)).toBe(
			"&lt;script&gt;alert(&quot;hi&quot;) &amp; &#39;bye&#39;&lt;/script&gt;",
		);
	});

	it("leaves ordinary text untouched", () => {
		expect(escapeHtml("api.example.com is not ready")).toBe("api.example.com is not ready");
	});
});

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: "f1", severity: "high", title: "Reachable by everyone", detail: "No require rule.",
		source: "access", href: "#/access",
		...overrides,
	};
}

function coverage(overrides: Partial<SourceCoverage> = {}): SourceCoverage {
	return { source: "access", label: "Access", status: "checked", count: 1, ...overrides };
}

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
	return {
		accountName: "Acme Corp",
		generatedAt: "2026-09-19T12:00:00.000Z",
		findings: [finding()],
		coverage: [coverage()],
		...overrides,
	};
}

describe("buildReportHtml", () => {
	it("is a self-contained document with no external resources or scripts", () => {
		const html = buildReportHtml(baseInput());
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).not.toContain("<script");
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toContain("<link");
	});

	it("escapes finding text so upstream data can never become markup", () => {
		const html = buildReportHtml(
			baseInput({
				findings: [finding({ title: `<img src=x onerror=alert(1)>`, detail: `Say "hi" & <b>bye</b>` })],
			}),
		);
		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain('Say "hi" & <b>bye</b>');
	});

	it("escapes the account name and a source's error reason", () => {
		const html = buildReportHtml(
			baseInput({
				accountName: `<b>Acme</b>`,
				coverage: [coverage({ source: "pqc", label: "PQC", status: "not-checked", reason: `token lacks "Zone: Read" & more` })],
			}),
		);
		expect(html).not.toContain("<b>Acme</b>");
		expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
		expect(html).toContain("&quot;Zone: Read&quot;");
	});

	it("lists every not-checked or not-opened source under 'what was not checked'", () => {
		const html = buildReportHtml(
			baseInput({
				coverage: [
					coverage(),
					coverage({ source: "waf", label: "WAF", status: "not-opened", reason: "Open WAF Analytics to include its findings." }),
					coverage({ source: "dns", label: "DNS Records", status: "not-checked", reason: "Permission missing to read this data." }),
				],
			}),
		);
		const notCheckedSection = html.slice(html.indexOf("What was not checked"));
		expect(notCheckedSection).toContain("WAF");
		expect(notCheckedSection).toContain("Open WAF Analytics");
		expect(notCheckedSection).toContain("DNS Records");
		expect(notCheckedSection).toContain("Permission missing");
		expect(notCheckedSection).not.toContain(">Access<");
	});

	it("says every source was checked when nothing is missing", () => {
		const html = buildReportHtml(baseInput({ coverage: [coverage()] }));
		const notCheckedSection = html.slice(html.indexOf("What was not checked"));
		expect(notCheckedSection).toContain("Every source was checked.");
	});

	it("totals severities across all findings, not just one source", () => {
		const html = buildReportHtml(
			baseInput({
				findings: [
					finding({ id: "1", severity: "high" }),
					finding({ id: "2", severity: "high" }),
					finding({ id: "3", severity: "medium", source: "dns", href: "#/dns" }),
					finding({ id: "4", severity: "low", source: "dns", href: "#/dns" }),
				],
				coverage: [coverage(), coverage({ source: "dns", label: "DNS Records" })],
			}),
		);
		expect(html).toMatch(/<div class="n">2<\/div>\s*<div class="label">High<\/div>/);
		expect(html).toMatch(/<div class="n">1<\/div>\s*<div class="label">Medium<\/div>/);
		expect(html).toMatch(/<div class="n">1<\/div>\s*<div class="label">Low<\/div>/);
	});

	it("only renders a per-source section for a source marked checked", () => {
		const html = buildReportHtml(
			baseInput({
				coverage: [coverage(), coverage({ source: "waf", label: "WAF", status: "not-opened", reason: "not opened" })],
			}),
		);
		// One <h2> for the checked source's section, one for Coverage, one for "What was not checked".
		const headingCount = (html.match(/<h2>/g) || []).length;
		expect(headingCount).toBe(3);
		expect(html).not.toMatch(/<h2>WAF<\/h2>/);
	});

	it("includes the account name and a human-readable generated-at timestamp", () => {
		const html = buildReportHtml(baseInput({ accountName: "Acme Corp" }));
		expect(html).toContain("Acme Corp");
		expect(html).toMatch(/Generated by Flarelens on/);
	});

	it("prints cleanly: declares A4 page size and page-break rules", () => {
		const html = buildReportHtml(baseInput());
		expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
		expect(html).toContain("break-inside: avoid");
	});
});

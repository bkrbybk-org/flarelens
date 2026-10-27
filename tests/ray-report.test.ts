import { describe, expect, it } from "vitest";
import { buildRayVerdict } from "../web/src/lib/waf/ray-verdict";
import { reviewRay } from "../web/src/lib/waf/ray-review";
import { explainExpression } from "../web/src/lib/waf/explain-expr";
import { buildRayReport, md } from "../web/src/lib/waf/ray-report";
import type { RuleMetaMap } from "../web/src/lib/waf/types";

/** The Markdown case report: what the page showed, safe to paste into a ticket. */

const meta: RuleMetaMap = {
	root: { name: "default", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", isRuleset: true },
	geo: { name: "Geo | block", ruleId: "geo", source: "zone", type: "custom", level: "zone", phase: "http_request_firewall_custom", ruleset: "default", rulesetId: "root", kind: "zone", action: "block", enabled: true, expression: 'ip.src.country in {"CN"}', position: 0 },
};
const request = { clientIP: "198.51.100.7", clientCountryName: "CN", clientRequestHTTPHost: "example.com", clientRequestPath: "/a_*b*", clientRequestHTTPMethodName: "GET", edgeResponseStatus: 403 };
const events = [{ ruleId: "geo", rulesetId: "root", action: "block", source: "firewallCustom", description: "Geo | block" }];

describe("buildRayReport", () => {
	it("carries the verdict, why it matched, the review, the drafts and the surroundings", () => {
		const verdict = buildRayVerdict(events, { securityAction: "block" }, meta);
		const review = reviewRay(verdict, request, events, meta);
		const report = buildRayReport({
			rayId: "a511938d1a0dd949",
			zone: "example.com",
			request,
			headline: 'Block by "Geo | block"',
			verdict,
			review,
			decidedExplanation: explainExpression(meta.geo.expression, request),
			context: { impact: { requests: 147, distinctClients: 66, distinctCapped: false, ruleEvents: 108, byAction: { block: 115, unknown: 22 } }, rule: { total: 500, sameClient: 7, samePath: 40, topHosts: [], topPaths: [], topCountries: [{ value: "NL", count: 3 }], topNetworks: [] } },
			windowLabel: "last 7 days",
			generatedAt: new Date("2026-10-27T00:00:00Z"),
		});
		expect(report).toContain("# Request investigation — Ray `a511938d1a0dd949`");
		expect(report).toContain('- `ip.src.country in {"CN"}` — request: ip.src.country = "CN"');
		expect(report).toContain("## Suggested changes");
		expect(report).toContain("147 from 66 clients; 108 stopped by the deciding rule");
		expect(report).toContain("served 22");
		expect(report).toContain("**Top countries:** NL (3)");
		// Request data cannot break the Markdown: emphasis and table pipes are escaped.
		expect(report).toContain("example.com/a\\_\\*b\\*");
		expect(report).toContain("| block | Geo \\| block | firewallCustom |");
		expect(report).toContain("2026-10-27T00:00:00.000Z");
	});

	it("escapes Markdown in values", () => {
		expect(md("<script>[x](y)|`z`")).toBe("\\<script\\>\\[x\\](y)\\|\\`z\\`");
		expect(md("a\nb")).toBe("a b");
	});
});

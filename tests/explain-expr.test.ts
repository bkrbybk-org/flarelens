import { describe, expect, it } from "vitest";
import { decisiveLeaves, explainExpression, unknownReasons } from "../web/src/lib/waf/explain-expr";

/** One expression against one request record, condition by condition, in three-valued logic. */

const req = {
	clientIP: "198.51.100.7",
	clientCountryName: "CN",
	clientAsn: 64500,
	clientRequestHTTPHost: "Example.com",
	clientRequestPath: "/wp-admin/install.php",
	clientRequestQuery: "?step=1",
	clientRequestHTTPMethodName: "POST",
	clientRequestScheme: "https",
	userAgent: "curl/8.4",
	wafAttackScore: 12,
	botScore: 1,
	verifiedBotCategory: "",
};

const result = (expr: string, r: Record<string, unknown> = req, zone?: { name?: string; plan?: string }) => explainExpression(expr, r, zone).result;

describe("explainExpression", () => {
	it("evaluates the common comparisons against the request's values", () => {
		expect(result('ip.src.country in {"CN" "RU"}')).toBe(true);
		expect(result("ip.src.asnum eq 64500")).toBe(true);
		expect(result("ip.src.asnum in {64000..64999}")).toBe(true);
		expect(result('http.request.method eq "GET"')).toBe(false);
		expect(result('lower(http.host) eq "example.com"')).toBe(true);
		expect(result('starts_with(http.request.uri.path, "/wp-")')).toBe(true);
		expect(result('http.request.uri.path.extension eq "php"')).toBe(true);
		expect(result('http.request.uri.query contains "step"')).toBe(true);
		expect(result('http.request.uri eq "/wp-admin/install.php?step=1"')).toBe(true);
		expect(result('http.request.uri.path wildcard "/WP-*"')).toBe(true);
		expect(result('http.request.uri.path strict wildcard "/WP-*"')).toBe(false);
		expect(result('http.user_agent matches "^curl/"')).toBe(true);
		expect(result('http.user_agent ~ r"^curl/\\d"')).toBe(true);
		expect(result("cf.waf.score le 20 and cf.bot_management.score lt 30")).toBe(true);
		expect(result("ssl and not cf.bot_management.verified_bot")).toBe(true);
		expect(result('http.host == "x" || ip.src.asnum != 1')).toBe(true);
	});

	it("matches addresses and ranges, v4 and v6", () => {
		expect(result("ip.src in {192.0.2.0/24 198.51.100.0/24}")).toBe(true);
		expect(result("ip.src eq 198.51.100.8")).toBe(false);
		expect(result("ip.src in {2001:db8::/32}", { clientIP: "2001:db8::1" })).toBe(true);
		expect(result("ip.src in {2001:db8::/32}", { clientIP: "2001:db9::1" })).toBe(false);
		expect(result("ip.src in {192.0.2.0/24}", { clientIP: "2001:db8::1" })).toBe(false);
	});

	it("lets a definite answer win over an unknown one, and says what is unknown", () => {
		// Headers are not in the record; the country decides anyway.
		expect(result('ip.src.country eq "US" and http.request.headers["x-a"][0] eq "b"')).toBe(false);
		expect(result('ip.src.country eq "CN" or any(http.request.headers.names[*] eq "x")')).toBe(true);
		const e = explainExpression('ip.src.country eq "CN" and ip.src in $office', req);
		expect(e.result).toBe("unknown");
		expect(unknownReasons(e.root)).toEqual(["$office is a list this page cannot read"]);
		expect(result('ip.src.continent eq "AS"', { clientCountryName: "ZZ" })).toBe("unknown");
	});

	it("derives the continent from the country, and says so", () => {
		const e = explainExpression('ip.src.continent in {"EU" "AS"}', { clientCountryName: "NL" });
		expect(e.result).toBe(true);
		expect(decisiveLeaves(e.root, true)[0].actual).toBe('ip.src.continent = "EU" (from country NL)');
		expect(result('ip.src.continent eq "T1"', { clientCountryName: "T1" })).toBe(true);
	});

	it("reads the zone's name and plan when given them", () => {
		expect(result('cf.zone.plan eq "ENT"', req, { name: "example.com", plan: "ENT" })).toBe(true);
		expect(result('cf.zone.plan eq "ENT"')).toBe("unknown");
	});

	it("names the conditions that decided it, with the request's values", () => {
		const e = explainExpression('(ip.src.country in {"CN"}) or (http.request.uri.path eq "/admin")', req);
		expect(decisiveLeaves(e.root, true).map((l) => [l.text, l.actual])).toEqual([['ip.src.country in {"CN"}', 'ip.src.country = "CN"']]);
		const miss = explainExpression('ip.src.country eq "US" and http.request.method eq "POST"', req);
		expect(decisiveLeaves(miss.root, false).map((l) => l.text)).toEqual(['ip.src.country eq "US"']);
		// A not() flips which leaves decided it.
		const not = explainExpression('not ip.src.country eq "CN"', req);
		expect(not.result).toBe(false);
		expect(decisiveLeaves(not.root, false).map((l) => l.text)).toEqual(['ip.src.country eq "CN"']);
	});

	it("reports an unreadable expression rather than guessing", () => {
		const e = explainExpression('http.host eq "unterminated', req);
		expect(e.result).toBe("unknown");
		expect(e.error).toBeTruthy();
		expect(explainExpression("", req).result).toBe(true);
	});
});

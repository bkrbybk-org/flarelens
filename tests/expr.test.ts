import { describe, expect, it } from "vitest";
import { compileExpression, compileTriState, UnsupportedExpressionError } from "../web/src/lib/expr";

const facts = (path: string, host = "example.com") => ({ path, host });

describe("compileExpression (strict boolean, attribution)", () => {
	it("eq / ne on path", () => {
		const eq = compileExpression('http.request.uri.path eq "/login"');
		expect(eq(facts("/login"))).toBe(true);
		expect(eq(facts("/other"))).toBe(false);
		const ne = compileExpression('http.request.uri.path ne "/login"');
		expect(ne(facts("/other"))).toBe(true);
	});

	it("symbol aliases == != && || !", () => {
		const p = compileExpression('http.request.uri.path == "/a" || http.request.uri.path == "/b"');
		expect(p(facts("/a"))).toBe(true);
		expect(p(facts("/b"))).toBe(true);
		expect(p(facts("/c"))).toBe(false);
		const n = compileExpression('!(http.host == "example.com") && http.request.uri.path != "/x"');
		expect(n(facts("/y", "other.com"))).toBe(true);
		expect(n(facts("/y"))).toBe(false);
	});

	it("contains / wildcard / matches", () => {
		expect(compileExpression('http.request.uri.path contains "static"')(facts("/static/app.js"))).toBe(true);
		const wc = compileExpression('http.request.uri.path wildcard "/img/*.png"');
		expect(wc(facts("/img/a.png"))).toBe(true);
		expect(wc(facts("/img/a.jpg"))).toBe(false);
		const re = compileExpression('http.request.uri.path matches "^/v[0-9]+/"');
		expect(re(facts("/v2/data"))).toBe(true);
		expect(re(facts("/vx/data"))).toBe(false);
	});

	it("in { … } sets and extension field", () => {
		const p = compileExpression('http.request.uri.path.extension in {"css" "js" "png"}');
		expect(p(facts("/app.JS"))).toBe(true); // extension lowercased
		expect(p(facts("/app.html"))).toBe(false);
		expect(p(facts("/no-extension"))).toBe(false);
	});

	it("starts_with / ends_with / lower()", () => {
		expect(compileExpression('starts_with(http.request.uri.path, "/api/")')(facts("/api/x"))).toBe(true);
		expect(compileExpression('ends_with(http.request.uri.path, ".map")')(facts("/app.js.map"))).toBe(true);
		expect(compileExpression('starts_with(lower(http.host), "ex")')(facts("/", "EXample.com"))).toBe(true);
	});

	it("path strips query for uri.path in attribution facts", () => {
		const p = compileExpression('http.request.uri.path eq "/x"');
		expect(p(facts("/x?y=1"))).toBe(true);
	});

	it("boolean literals and parens precedence", () => {
		expect(compileExpression("true")(facts("/"))).toBe(true);
		const p = compileExpression('(http.request.uri.path eq "/a" or http.request.uri.path eq "/b") and http.host eq "example.com"');
		expect(p(facts("/a"))).toBe(true);
		expect(p(facts("/a", "other.com"))).toBe(false);
	});

	it("empty expression matches everything", () => {
		expect(compileExpression("")(facts("/anything"))).toBe(true);
	});

	it("throws UnsupportedExpressionError naming unsupported fields", () => {
		expect(() => compileExpression('http.cookie contains "session"')).toThrow(UnsupportedExpressionError);
		try {
			compileExpression('http.cookie contains "s" and ip.src eq 1.2.3.4');
		} catch (e) {
			expect((e as Error).message).toContain("http.cookie");
			expect((e as Error).message).toContain("ip.src");
		}
	});

	it("forAttribution rejects query-dependent fields", () => {
		expect(() => compileExpression('http.request.uri.query contains "x"', { forAttribution: true })).toThrow(
			UnsupportedExpressionError,
		);
		// but the same field is fine for the URL tester
		const tri = compileTriState('http.request.uri.query contains "x"');
		expect(tri.evaluate(facts("/p?x=1"))).toBe(true);
	});

	it("throws a human-readable message on unparseable syntax", () => {
		expect(() => compileExpression("this is (not valid")).toThrow("syntax the built-in evaluator does not support");
	});
});

describe("compileTriState (Kleene three-valued, URL tester)", () => {
	it("unknown leaves evaluate to 'unknown' and are named", () => {
		const c = compileTriState('http.cookie contains "session"');
		expect(c.evaluate(facts("/"))).toBe("unknown");
		expect(c.unknownFields).toContain("http.cookie");
	});

	it("false AND unknown = false (definite false wins)", () => {
		const c = compileTriState('http.request.uri.path eq "/never" and http.cookie contains "s"');
		expect(c.evaluate(facts("/other"))).toBe(false);
	});

	it("true OR unknown = true", () => {
		const c = compileTriState('http.request.uri.path eq "/hit" or http.cookie contains "s"');
		expect(c.evaluate(facts("/hit"))).toBe(true);
	});

	it("true AND unknown = unknown; false OR unknown = unknown", () => {
		const andC = compileTriState('http.request.uri.path eq "/hit" and http.cookie contains "s"');
		expect(andC.evaluate(facts("/hit"))).toBe("unknown");
		const orC = compileTriState('http.request.uri.path eq "/never" or http.cookie contains "s"');
		expect(orC.evaluate(facts("/other"))).toBe("unknown");
	});

	it("not unknown = unknown; xor with unknown = unknown", () => {
		expect(compileTriState('not http.cookie contains "s"').evaluate(facts("/"))).toBe("unknown");
		expect(compileTriState('true xor http.cookie contains "s"').evaluate(facts("/"))).toBe("unknown");
	});

	it("unparseable expression → always unknown, flagged", () => {
		const c = compileTriState("%%% nonsense");
		expect(c.evaluate(facts("/"))).toBe("unknown");
		expect(c.unknownFields).toContain("unparseable expression");
	});

	it("full_uri includes host and query", () => {
		const c = compileTriState('http.request.full_uri contains "example.com/p?x=1"');
		expect(c.evaluate(facts("/p?x=1"))).toBe(true);
	});

	it("invalid regex degrades to unknown, not crash", () => {
		const c = compileTriState('http.request.uri.path matches "([unclosed"');
		expect(c.evaluate(facts("/x"))).toBe("unknown");
		expect(c.unknownFields.some((f) => f.includes("invalid regex"))).toBe(true);
	});
});

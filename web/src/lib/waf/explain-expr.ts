/**
 * "Why did this rule match — or not?" One Rules-language expression evaluated against one request
 * record, condition by condition.
 *
 * Unlike lib/expr.ts, which answers yes/no over a URL, this keeps the tree: every condition carries
 * the request's actual value and its own result, so the page can say "matched because
 * ip.src.country is CN" or "did not match: the path was /api, not /admin".
 *
 * Kleene three-valued logic throughout. A field the request record does not carry (headers,
 * cookies, IP lists, the continent…) is "unknown", and unknown only decides the outcome where a
 * definite answer elsewhere cannot: `false and unknown` is still false. So a "didn't match" is only
 * claimed when the known conditions prove it.
 */

export type Tri = boolean | "unknown";

export interface ExplainLeaf {
	kind: "leaf";
	/** The condition as written. */
	text: string;
	result: Tri;
	/** The request's value for the field, when the record has it. */
	actual?: string;
	/** Why the result is unknown. */
	reason?: string;
}

export interface ExplainGroup {
	kind: "and" | "or" | "xor" | "not";
	result: Tri;
	children: ExplainNode[];
}

export type ExplainNode = ExplainLeaf | ExplainGroup;

export interface Explanation {
	result: Tri;
	root: ExplainNode | null;
	/** Set when the expression could not be parsed at all. */
	error?: string;
}

type Value = string | number | boolean | string[] | undefined;
type Request = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));
const numeric = (v: unknown): number | undefined => {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
};
const positive = (v: unknown) => {
	const n = numeric(v);
	return n !== undefined && n > 0 ? n : undefined;
};

function uri(r: Request): string | undefined {
	const path = str(r.clientRequestPath);
	if (path === undefined) return undefined;
	const query = str(r.clientRequestQuery)?.replace(/^\?/, "");
	return query ? `${path}?${query}` : path;
}

/**
 * `ip.src.continent` from the country, which the record does carry. GeoNames-style assignment;
 * Cloudflare's own GeoIP may place a transcontinental country (Türkiye, Russia, Cyprus) differently,
 * so the value shown says it was derived. T1 is Tor, which Cloudflare reports as both.
 */
const CONTINENT_COUNTRIES: Record<string, string> = {
	EU: "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
	AS: "AE AF AM AZ BD BH BN BT CC CN CX GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
	AF: "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
	NA: "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT UM US VC VG VI",
	SA: "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
	OC: "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
	AN: "AQ BV GS HM TF",
	T1: "T1",
};
const CONTINENT = new Map(Object.entries(CONTINENT_COUNTRIES).flatMap(([continent, list]) => list.split(" ").map((c) => [c, continent] as const)));

const ZONE_NAME = "@zone.name";
const ZONE_PLAN = "@zone.plan";

/** Rules-language fields this record can answer, mapped to the request row. */
const FIELDS: Record<string, (r: Request) => Value> = {
	"ip.src": (r) => str(r.clientIP),
	"ip.src.country": (r) => str(r.clientCountryName),
	"ip.geoip.country": (r) => str(r.clientCountryName),
	"ip.src.continent": (r) => CONTINENT.get(str(r.clientCountryName)?.toUpperCase() ?? ""),
	"ip.geoip.continent": (r) => CONTINENT.get(str(r.clientCountryName)?.toUpperCase() ?? ""),
	"ip.src.asnum": (r) => numeric(r.clientAsn),
	"ip.geoip.asnum": (r) => numeric(r.clientAsn),
	"http.host": (r) => str(r.clientRequestHTTPHost),
	"http.request.host": (r) => str(r.clientRequestHTTPHost),
	"http.request.uri.path": (r) => str(r.clientRequestPath),
	"http.request.uri.path.extension": (r) => {
		const path = str(r.clientRequestPath);
		if (path === undefined) return undefined;
		const segment = path.split("/").pop() ?? "";
		const dot = segment.lastIndexOf(".");
		return dot > 0 ? segment.slice(dot + 1).toLowerCase() : "";
	},
	"http.request.uri.query": (r) => (r.clientRequestPath === undefined ? undefined : (str(r.clientRequestQuery)?.replace(/^\?/, "") ?? "")),
	"http.request.uri": uri,
	"http.request.full_uri": (r) => {
		const u = uri(r);
		const host = str(r.clientRequestHTTPHost);
		return u === undefined || host === undefined ? undefined : `${str(r.clientRequestScheme) ?? "https"}://${host}${u}`;
	},
	"http.request.method": (r) => str(r.clientRequestHTTPMethodName),
	"http.user_agent": (r) => str(r.userAgent) ?? str(r.clientRequestUserAgent),
	"http.referer": (r) => str(r.clientRequestReferer),
	"http.request.version": (r) => str(r.clientRequestHTTPProtocol),
	ssl: (r) => (str(r.clientRequestScheme) === undefined ? undefined : str(r.clientRequestScheme) === "https"),
	"cf.waf.score": (r) => positive(r.wafAttackScore),
	"cf.waf.score.sqli": (r) => positive(r.wafSqliAttackScore),
	"cf.waf.score.xss": (r) => positive(r.wafXssAttackScore),
	"cf.waf.score.rce": (r) => positive(r.wafRceAttackScore),
	"cf.bot_management.score": (r) => positive(r.botScore),
	"cf.bot_management.ja3_hash": (r) => str(r.ja3Hash),
	"cf.bot_management.ja4": (r) => str(r.ja4),
	"cf.bot_management.verified_bot": (r) => ("verifiedBotCategory" in r ? Boolean(str(r.verifiedBotCategory)) : undefined),
	"cf.client.bot": (r) => ("verifiedBotCategory" in r ? Boolean(str(r.verifiedBotCategory)) : undefined),
	"cf.verified_bot_category": (r) => ("verifiedBotCategory" in r ? (str(r.verifiedBotCategory) ?? "") : undefined),
	"cf.llm.prompt.injection_score": (r) => positive(r.firewallForAiInjectionScore),
	// Not on the request row; the zone the request was found in supplies them.
	"cf.zone.name": (r) => str(r[ZONE_NAME]),
	"cf.zone.plan": (r) => str(r[ZONE_PLAN]),
};

/* ------------------------------------------------------------------ tokens */

interface Token {
	kind: "str" | "word" | "op" | "(" | ")" | "{" | "}" | "[" | "]" | ",";
	value: string;
	start: number;
	end: number;
}

const OPS = ["==", "!=", ">=", "<=", "&&", "||", "^^", ">", "<", "!", "~"];

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if ("(){}[],".includes(ch)) {
			out.push({ kind: ch as Token["kind"], value: ch, start: i, end: i + 1 });
			i++;
			continue;
		}
		// Raw strings: r"…" and r#"…"#.
		const raw = /^r(#*)"/.exec(src.slice(i));
		if (raw) {
			const close = `"${raw[1]}`;
			const bodyStart = i + raw[0].length;
			const endAt = src.indexOf(close, bodyStart);
			if (endAt === -1) throw new Error("Unterminated string");
			out.push({ kind: "str", value: src.slice(bodyStart, endAt), start: i, end: endAt + close.length });
			i = endAt + close.length;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			let value = "";
			while (j < src.length && src[j] !== '"') {
				if (src[j] === "\\" && j + 1 < src.length) {
					value += src[j + 1];
					j += 2;
				} else value += src[j++];
			}
			if (j >= src.length) throw new Error("Unterminated string");
			out.push({ kind: "str", value, start: i, end: j + 1 });
			i = j + 1;
			continue;
		}
		const op = OPS.find((o) => src.startsWith(o, i));
		if (op) {
			out.push({ kind: "op", value: op, start: i, end: i + op.length });
			i += op.length;
			continue;
		}
		const word = /^[A-Za-z0-9_.:/$*-]+/.exec(src.slice(i));
		if (!word) throw new Error(`Unexpected "${ch}"`);
		out.push({ kind: "word", value: word[0], start: i, end: i + word[0].length });
		i += word[0].length;
	}
	return out;
}

/* --------------------------------------------------------------------- AST */

type Operand =
	| { kind: "field"; name: string; unsupported?: string }
	| { kind: "call"; name: string; args: (Operand | Literal)[] };
type Literal = { kind: "lit"; value: string; quoted: boolean };
type SetItem = { value: string; quoted: boolean };

type Ast =
	| { kind: "and" | "or" | "xor"; children: Ast[] }
	| { kind: "not"; child: Ast }
	| { kind: "const"; value: boolean; text: string }
	| { kind: "cmp"; left: Operand; op?: string; right?: Literal | { kind: "set"; items: SetItem[] } | { kind: "list"; name: string }; text: string };

const KEYWORD_OP: Record<string, string> = { "==": "eq", "!=": "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le", "~": "matches" };
const COMPARE = new Set(["eq", "ne", "gt", "ge", "lt", "le", "contains", "matches", "wildcard", "strict", "in"]);

class Parser {
	private pos = 0;
	constructor(
		private tokens: Token[],
		private src: string,
	) {}

	private peek() {
		return this.tokens[this.pos];
	}
	private next() {
		const t = this.tokens[this.pos++];
		if (!t) throw new Error("Unexpected end of expression");
		return t;
	}
	private expect(kind: Token["kind"]) {
		const t = this.next();
		if (t.kind !== kind) throw new Error(`Expected ${kind}`);
		return t;
	}
	private isWord(value: string) {
		const t = this.peek();
		return t?.kind === "word" && t.value === value;
	}
	private isOp(value: string) {
		const t = this.peek();
		return t?.kind === "op" && t.value === value;
	}

	parse(): Ast {
		const ast = this.or();
		if (this.pos !== this.tokens.length) throw new Error("Unexpected trailing input");
		return ast;
	}

	private or(): Ast {
		const children = [this.xor()];
		while (this.isWord("or") || this.isOp("||")) {
			this.pos++;
			children.push(this.xor());
		}
		return children.length === 1 ? children[0] : { kind: "or", children };
	}

	private xor(): Ast {
		const children = [this.and()];
		while (this.isWord("xor") || this.isOp("^^")) {
			this.pos++;
			children.push(this.and());
		}
		return children.length === 1 ? children[0] : { kind: "xor", children };
	}

	private and(): Ast {
		const children = [this.not()];
		while (this.isWord("and") || this.isOp("&&")) {
			this.pos++;
			children.push(this.not());
		}
		return children.length === 1 ? children[0] : { kind: "and", children };
	}

	private not(): Ast {
		if (this.isWord("not") || this.isOp("!")) {
			this.pos++;
			return { kind: "not", child: this.not() };
		}
		return this.primary();
	}

	private primary(): Ast {
		const t = this.peek();
		if (t?.kind === "(") {
			this.pos++;
			const inner = this.or();
			this.expect(")");
			return inner;
		}
		if (t?.kind === "word" && (t.value === "true" || t.value === "false")) {
			this.pos++;
			return { kind: "const", value: t.value === "true", text: t.value };
		}
		const start = t?.start ?? 0;
		const left = this.operand();
		let op: string | undefined;
		const opTok = this.peek();
		if (opTok?.kind === "op" && KEYWORD_OP[opTok.value]) op = KEYWORD_OP[opTok.value];
		else if (opTok?.kind === "word" && COMPARE.has(opTok.value)) op = opTok.value;
		if (!op) return { kind: "cmp", left, text: this.src.slice(start, this.tokens[this.pos - 1].end) };
		this.pos++;
		if (op === "strict") {
			if (!this.isWord("wildcard")) throw new Error("Expected wildcard");
			this.pos++;
		}
		let right: Extract<Ast, { kind: "cmp" }>["right"];
		if (op === "in") {
			const next = this.peek();
			if (next?.kind === "word" && next.value.startsWith("$")) {
				this.pos++;
				right = { kind: "list", name: next.value };
			} else {
				this.expect("{");
				const items: SetItem[] = [];
				while (this.peek()?.kind !== "}") {
					const item = this.next();
					if (item.kind !== "str" && item.kind !== "word") throw new Error("Bad set item");
					items.push({ value: item.value, quoted: item.kind === "str" });
				}
				this.expect("}");
				right = { kind: "set", items };
			}
		} else {
			const value = this.next();
			if (value.kind !== "str" && value.kind !== "word") throw new Error("Expected a value");
			right = { kind: "lit", value: value.value, quoted: value.kind === "str" };
		}
		return { kind: "cmp", left, op, right, text: this.src.slice(start, this.tokens[this.pos - 1].end) };
	}

	/** A field (possibly indexed, which this cannot read) or a function call. */
	private operand(): Operand {
		const t = this.next();
		if (t.kind !== "word") throw new Error("Expected a field");
		if (this.peek()?.kind === "(") {
			this.pos++;
			const args: (Operand | Literal)[] = [];
			while (this.peek()?.kind !== ")") {
				const a = this.peek();
				if (a?.kind === "str") {
					this.pos++;
					args.push({ kind: "lit", value: a.value, quoted: true });
				} else if (a?.kind === "word" && /^[\d.]+$/.test(a.value)) {
					this.pos++;
					args.push({ kind: "lit", value: a.value, quoted: false });
				} else args.push(this.operand());
				// A comparison inside a call (any(x[*] eq "y")) — skip to the call's end; unknown anyway.
				while (this.peek() && this.peek()!.kind !== "," && this.peek()!.kind !== ")") this.skipBalanced();
				if (this.peek()?.kind === ",") this.pos++;
			}
			this.expect(")");
			return { kind: "call", name: t.value, args };
		}
		let unsupported: string | undefined;
		while (this.peek()?.kind === "[") {
			// headers["x"], args.names[*] — maps and arrays the record does not carry.
			this.skipBalanced();
			unsupported = `${t.value}[…]`;
		}
		return { kind: "field", name: t.value, unsupported };
	}

	private skipBalanced() {
		const t = this.next();
		const close = t.kind === "(" ? ")" : t.kind === "[" ? "]" : t.kind === "{" ? "}" : null;
		if (!close) return;
		while (this.peek() && this.peek()!.kind !== close) this.skipBalanced();
		this.expect(close as Token["kind"]);
	}
}

/* ---------------------------------------------------------------- evaluate */

interface Resolved {
	value?: Value;
	/** Why it can't be read. */
	reason?: string;
	/** For display: what the request had. */
	shown?: string;
}

function resolve(operand: Operand | Literal, r: Request): Resolved {
	if (operand.kind === "lit") return { value: operand.quoted ? operand.value : (numeric(operand.value) ?? operand.value) };
	if (operand.kind === "field") {
		if (operand.unsupported) return { reason: `${operand.unsupported} is not in the request record` };
		const getter = FIELDS[operand.name];
		if (!getter) return { reason: `${operand.name} is not in the request record` };
		const value = getter(r);
		if (value === undefined) return { reason: `${operand.name} was not recorded for this request` };
		const derived = operand.name.endsWith(".continent") ? ` (from country ${str(r.clientCountryName)})` : "";
		return { value, shown: `${operand.name} = ${display(value)}${derived}` };
	}
	const args = operand.args.map((a) => resolve(a, r));
	const missing = args.find((a) => a.value === undefined);
	if (missing) return { reason: missing.reason ?? `${operand.name}() could not be evaluated` };
	const first = args[0]?.value;
	const shown = args.find((a) => a.shown)?.shown;
	switch (operand.name) {
		case "lower":
			return { value: String(first).toLowerCase(), shown };
		case "upper":
			return { value: String(first).toUpperCase(), shown };
		case "len":
			return { value: String(first).length, shown };
		case "starts_with":
			return { value: String(first).startsWith(String(args[1]?.value)), shown };
		case "ends_with":
			return { value: String(first).endsWith(String(args[1]?.value)), shown };
		default:
			return { reason: `${operand.name}() is not evaluated here` };
	}
}

function display(value: Value): string {
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "string") return JSON.stringify(value);
	return String(value);
}

/* IP addresses and CIDR ranges, v4 and v6, as BigInts. */
function ipToBig(ip: string): { big: bigint; bits: number } | null {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
		const parts = ip.split(".").map(Number);
		if (parts.some((p) => p > 255)) return null;
		return { big: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n), bits: 32 };
	}
	if (!ip.includes(":")) return null;
	const [head, tail = ""] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
	const groups = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
	return { big: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n), bits: 128 };
}

function ipInRange(ip: string, range: string): boolean | undefined {
	const [base, prefixText] = range.split("/");
	const a = ipToBig(ip);
	const b = ipToBig(base);
	if (!a || !b) return undefined;
	if (a.bits !== b.bits) return false;
	const prefix = prefixText === undefined ? a.bits : Number(prefixText);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return undefined;
	const shift = BigInt(a.bits - prefix);
	return a.big >> shift === b.big >> shift;
}

const isIpField = (operand: Operand) => operand.kind === "field" && (operand.name === "ip.src" || operand.name === "ip.dst");

function wildcard(pattern: string, value: string, caseSensitive: boolean): boolean {
	const re = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${re}$`, caseSensitive ? "" : "i").test(value);
}

function compare(node: Extract<Ast, { kind: "cmp" }>, r: Request): ExplainLeaf {
	const left = resolve(node.left, r);
	const leaf = (result: Tri, reason?: string): ExplainLeaf => ({ kind: "leaf", text: node.text, result, actual: left.shown, reason });
	if (left.value === undefined) return leaf("unknown", left.reason);
	const v = left.value;
	if (!node.op) return typeof v === "boolean" ? leaf(v) : leaf("unknown", "not a true/false value");
	const right = node.right!;
	if (right.kind === "list") return leaf("unknown", `${right.name} is a list this page cannot read`);
	if (node.op === "in") {
		const set = (right as { items: SetItem[] }).items;
		if (isIpField(node.left)) {
			const results = set.map((item) => ipInRange(String(v), item.value));
			if (results.includes(true)) return leaf(true);
			return results.includes(undefined) ? leaf("unknown", "an address in the set could not be read") : leaf(false);
		}
		const hit = set.some((item) => {
			const range = !item.quoted && /^(\d+)\.\.(\d+)$/.exec(item.value);
			if (range && typeof v === "number") return v >= Number(range[1]) && v <= Number(range[2]);
			return item.quoted || typeof v !== "number" ? String(v) === item.value : v === Number(item.value);
		});
		return leaf(hit);
	}
	const lit = right as Literal;
	const target = lit.quoted ? lit.value : (numeric(lit.value) ?? lit.value);
	if ((node.op === "eq" || node.op === "ne") && isIpField(node.left)) {
		const same = ipInRange(String(v), lit.value);
		if (same === undefined) return leaf("unknown", "address could not be compared");
		return leaf(node.op === "eq" ? same : !same);
	}
	switch (node.op) {
		case "eq":
			return leaf(typeof target === "number" && typeof v === "number" ? v === target : String(v) === String(target));
		case "ne":
			return leaf(typeof target === "number" && typeof v === "number" ? v !== target : String(v) !== String(target));
		case "gt":
		case "ge":
		case "lt":
		case "le": {
			const a = numeric(v);
			const b = numeric(target);
			if (a === undefined || b === undefined) return leaf("unknown", "not a number");
			return leaf(node.op === "gt" ? a > b : node.op === "ge" ? a >= b : node.op === "lt" ? a < b : a <= b);
		}
		case "contains":
			return leaf(String(v).includes(String(target)));
		case "wildcard":
			return leaf(wildcard(String(target), String(v), false));
		case "strict":
			return leaf(wildcard(String(target), String(v), true));
		case "matches":
			try {
				return leaf(new RegExp(String(target)).test(String(v)));
			} catch {
				return leaf("unknown", "the regular expression uses syntax JavaScript does not");
			}
		default:
			return leaf("unknown", `operator ${node.op} is not evaluated here`);
	}
}

function evaluate(ast: Ast, r: Request): ExplainNode {
	switch (ast.kind) {
		case "const":
			return { kind: "leaf", text: ast.text, result: ast.value };
		case "cmp":
			return compare(ast, r);
		case "not": {
			const child = evaluate(ast.child, r);
			return { kind: "not", result: child.result === "unknown" ? "unknown" : !child.result, children: [child] };
		}
		default: {
			const children = ast.children.map((c) => evaluate(c, r));
			const results = children.map((c) => c.result);
			let result: Tri;
			if (ast.kind === "and") result = results.includes(false) ? false : results.includes("unknown") ? "unknown" : true;
			else if (ast.kind === "or") result = results.includes(true) ? true : results.includes("unknown") ? "unknown" : false;
			else result = results.includes("unknown") ? "unknown" : results.filter(Boolean).length % 2 === 1;
			return { kind: ast.kind, result, children };
		}
	}
}

export function explainExpression(expression: string | undefined, request: Request = {}, zone?: { name?: string; plan?: string }): Explanation {
	const src = (expression ?? "").trim();
	if (!src) return { result: true, root: null };
	try {
		const facts = zone ? { ...request, [ZONE_NAME]: zone.name, [ZONE_PLAN]: zone.plan } : request;
		const root = evaluate(new Parser(tokenize(src), src).parse(), facts);
		return { result: root.result, root };
	} catch (err) {
		return { result: "unknown", root: null, error: err instanceof Error ? err.message : "Could not read the expression" };
	}
}

/** Leaves that decided the outcome: the true ones for a match, the false ones for a miss. */
export function decisiveLeaves(node: ExplainNode | null, want: boolean): ExplainLeaf[] {
	if (!node) return [];
	if (node.kind === "leaf") return node.result === want ? [node] : [];
	if (node.kind === "not") return decisiveLeaves(node.children[0], !want);
	return node.children.filter((c) => c.result === want).flatMap((c) => decisiveLeaves(c, want));
}

/** Distinct reasons the explanation could not decide. */
export function unknownReasons(node: ExplainNode | null): string[] {
	if (!node) return [];
	if (node.kind === "leaf") return node.result === "unknown" && node.reason ? [node.reason] : [];
	return [...new Set(node.children.flatMap(unknownReasons))];
}

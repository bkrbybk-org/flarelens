/**
 * Minimal wirefilter (Cloudflare Rules language) expression evaluator.
 *
 * Two consumers with different honesty requirements:
 *
 *  - Attribution (compileExpression): strict boolean predicates over
 *    path/host facts derived from clientRequestPath analytics. Expressions
 *    using fields those facts cannot represent (cookies, headers, IP — and
 *    query-string fields, since clientRequestPath strips the query) throw
 *    UnsupportedExpressionError so the caller marks the rule unattributable
 *    instead of silently mis-crediting traffic.
 *
 *  - URL tester (compileTriState): Kleene three-valued evaluation. Facts
 *    come from user input (which may include a query string), unsupported
 *    leaves evaluate to "unknown", and unknown propagates through
 *    and/or/not/xor so a definite false still wins over an unknown branch.
 *
 * Grammar subset:
 *   operators: eq, ne, contains, wildcard, matches, in {...}
 *   functions: starts_with(field, "x"), ends_with(field, "x"), lower(field)
 *   boolean:   and, or, not, xor, parentheses, true, false
 */

export class UnsupportedExpressionError extends Error {}

export type RequestFacts = {
  path: string; // may include ?query when the caller has it (URL tester)
  host: string; // e.g. example.com
};

export type TriBool = boolean | "unknown";
export type TriPredicate = (facts: RequestFacts) => TriBool;
export type Predicate = (facts: RequestFacts) => boolean;

export type CompileOptions = {
  /**
   * Attribution facts come from clientRequestPath, which strips the query
   * string — query-dependent fields must be treated as unsupported there.
   */
  forAttribution?: boolean;
};

export type TriCompiled = {
  evaluate: TriPredicate;
  /** Distinct unsupported field/feature names encountered at compile time. */
  unknownFields: string[];
};

const SUPPORTED_FIELDS = new Set([
  "http.request.uri.path",
  "http.request.uri.path.extension",
  "http.request.uri.query",
  "http.request.uri",
  "http.request.full_uri",
  "http.host",
  "http.request.host", // lenient alias
]);

/** Field values that depend on the query string. */
const QUERY_FIELDS = new Set(["http.request.uri.query", "http.request.uri", "http.request.full_uri"]);

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "lbrace" }
  | { kind: "rbrace" }
  | { kind: "comma" };

type TokenStep = { token: Token; next: number };

const SINGLE_CHAR_TOKENS: Record<string, Token["kind"]> = {
  "(": "lparen",
  ")": "rparen",
  "{": "lbrace",
  "}": "rbrace",
  ",": "comma",
};

/** Symbolic operator aliases (==, !=, &&, ||, !) mapped to keyword form. */
const SYMBOL_OPERATORS: Array<[symbol_: string, keyword: string]> = [
  ["==", "eq"],
  ["!=", "ne"],
  ["&&", "and"],
  ["||", "or"],
  ["!", "not"],
];

function readString(src: string, start: number): TokenStep {
  let i = start + 1; // skip opening quote
  let out = "";
  while (i < src.length && src[i] !== '"') {
    if (src[i] === "\\" && i + 1 < src.length) {
      out += src[i + 1];
      i += 2;
    } else {
      out += src[i];
      i++;
    }
  }
  if (i >= src.length) throw new UnsupportedExpressionError("Unterminated string");
  return { token: { kind: "string", value: out }, next: i + 1 };
}

function readNumber(src: string, start: number): TokenStep {
  let i = start;
  while (i < src.length && /[\d.]/.test(src[i])) i++;
  return { token: { kind: "number", value: Number(src.slice(start, i)) }, next: i };
}

function readIdent(src: string, start: number): TokenStep {
  let i = start;
  while (i < src.length && /[a-zA-Z0-9_.]/.test(src[i])) i++;
  return { token: { kind: "ident", value: src.slice(start, i) }, next: i };
}

function readSymbolOperator(src: string, start: number): TokenStep {
  for (const [symbol_, keyword] of SYMBOL_OPERATORS) {
    if (src.startsWith(symbol_, start)) {
      return { token: { kind: "ident", value: keyword }, next: start + symbol_.length };
    }
  }
  throw new UnsupportedExpressionError(`Unexpected character '${src[start]}'`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const singleKind = SINGLE_CHAR_TOKENS[ch];
    if (singleKind) {
      tokens.push({ kind: singleKind } as Token);
      i++;
      continue;
    }
    const step = readToken(src, i, ch);
    tokens.push(step.token);
    i = step.next;
  }
  return tokens;
}

function readToken(src: string, i: number, ch: string): TokenStep {
  if (ch === '"') return readString(src, i);
  if (/\d/.test(ch)) return readNumber(src, i);
  if (/[a-zA-Z_]/.test(ch)) return readIdent(src, i);
  return readSymbolOperator(src, i);
}

/** Resolve a supported field identifier to its value for the given facts. */
function fieldValue(name: string, facts: RequestFacts): string {
  switch (name) {
    case "http.request.uri.path": {
      const q = facts.path.indexOf("?");
      return q === -1 ? facts.path : facts.path.slice(0, q);
    }
    case "http.request.uri.path.extension": {
      const clean = fieldValue("http.request.uri.path", facts);
      const seg = clean.split("/").pop() ?? "";
      const dot = seg.lastIndexOf(".");
      return dot > 0 ? seg.slice(dot + 1).toLowerCase() : "";
    }
    case "http.request.uri.query": {
      const q = facts.path.indexOf("?");
      return q === -1 ? "" : facts.path.slice(q + 1);
    }
    case "http.request.uri":
      return facts.path;
    case "http.request.full_uri":
      return `https://${facts.host}${facts.path}`;
    default: // http.host / http.request.host — membership checked at parse time
      return facts.host;
  }
}

/** Convert a wirefilter wildcard pattern to a RegExp ('*' matches any run). */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

type FieldGetter = (facts: RequestFacts) => string;

/* ---------------- Kleene three-valued combinators ---------------- */

function triAnd(a: TriPredicate, b: TriPredicate): TriPredicate {
  return (f) => {
    const x = a(f);
    if (x === false) return false;
    const y = b(f);
    if (y === false) return false;
    if (x === "unknown" || y === "unknown") return "unknown";
    return true;
  };
}

function triOr(a: TriPredicate, b: TriPredicate): TriPredicate {
  return (f) => {
    const x = a(f);
    if (x === true) return true;
    const y = b(f);
    if (y === true) return true;
    if (x === "unknown" || y === "unknown") return "unknown";
    return false;
  };
}

function triXor(a: TriPredicate, b: TriPredicate): TriPredicate {
  return (f) => {
    const x = a(f);
    const y = b(f);
    if (x === "unknown" || y === "unknown") return "unknown";
    return x !== y;
  };
}

function triNot(a: TriPredicate): TriPredicate {
  return (f) => {
    const x = a(f);
    return x === "unknown" ? "unknown" : !x;
  };
}

function buildComparator(op: string, getRaw: FieldGetter, val: string): TriPredicate | null {
  switch (op) {
    case "eq":
      return (f) => getRaw(f) === val;
    case "ne":
      return (f) => getRaw(f) !== val;
    case "contains":
      return (f) => getRaw(f).includes(val);
    case "wildcard": {
      const re = wildcardToRegex(val);
      return (f) => re.test(getRaw(f));
    }
    case "matches": {
      let re: RegExp;
      try {
        re = new RegExp(val);
      } catch {
        return null; // bad regex → unsupported leaf
      }
      return (f) => re.test(getRaw(f));
    }
    default:
      return null; // unsupported operator → unsupported leaf
  }
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  private options: CompileOptions;
  readonly unknownFields: string[] = [];

  constructor(tokens: Token[], options: CompileOptions) {
    this.tokens = tokens;
    this.options = options;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new UnsupportedExpressionError("Unexpected end of expression");
    return t;
  }
  private expect(kind: Token["kind"]): Token {
    const t = this.next();
    if (t.kind !== kind) throw new UnsupportedExpressionError(`Expected ${kind}`);
    return t;
  }
  private peekIdent(): string | null {
    const t = this.peek();
    return t?.kind === "ident" ? t.value : null;
  }

  private fieldSupported(name: string): boolean {
    if (!SUPPORTED_FIELDS.has(name)) return false;
    if (this.options.forAttribution && QUERY_FIELDS.has(name)) return false;
    return true;
  }

  private unknownLeaf(detail: string): TriPredicate {
    if (!this.unknownFields.includes(detail)) this.unknownFields.push(detail);
    return () => "unknown";
  }

  parse(): TriPredicate {
    const pred = this.parseOr();
    if (this.pos !== this.tokens.length) throw new UnsupportedExpressionError("Trailing tokens");
    return pred;
  }

  private parseOr(): TriPredicate {
    let left = this.parseAnd();
    for (let op = this.peekIdent(); op === "or" || op === "xor"; op = this.peekIdent()) {
      this.pos++;
      const right = this.parseAnd();
      left = op === "or" ? triOr(left, right) : triXor(left, right);
    }
    return left;
  }

  private parseAnd(): TriPredicate {
    let left = this.parseNot();
    while (this.peekIdent() === "and") {
      this.pos++;
      left = triAnd(left, this.parseNot());
    }
    return left;
  }

  private parseNot(): TriPredicate {
    if (this.peekIdent() === "not") {
      this.pos++;
      return triNot(this.parseNot());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): TriPredicate {
    const t = this.next();
    if (t.kind === "lparen") return this.parseParenGroup();
    if (t.kind !== "ident") throw new UnsupportedExpressionError("Expected identifier");
    if (t.value === "true") return () => true;
    if (t.value === "false") return () => false;
    if (t.value === "starts_with" || t.value === "ends_with") {
      return this.parseFunctionComparison(t.value);
    }
    return this.parseFieldComparison(t.value);
  }

  private parseParenGroup(): TriPredicate {
    const inner = this.parseOr();
    this.expect("rparen");
    return inner;
  }

  /** starts_with(field, "x") / ends_with(field, "x") */
  private parseFunctionComparison(fn: "starts_with" | "ends_with"): TriPredicate {
    this.expect("lparen");
    const operand = this.parseStringOperand();
    this.expect("comma");
    const arg = this.expect("string") as Extract<Token, { kind: "string" }>;
    this.expect("rparen");
    if (!operand.supported) return this.unknownLeaf(operand.field);
    const field = operand.get;
    return fn === "starts_with"
      ? (f) => field(f).startsWith(arg.value)
      : (f) => field(f).endsWith(arg.value);
  }

  /** <field> <op> <value> — including `in {"a" "b"}` sets. */
  private parseFieldComparison(fieldName: string): TriPredicate {
    const supported = this.fieldSupported(fieldName);
    const getRaw: FieldGetter = (f) => fieldValue(fieldName, f);
    const opTok = this.next();
    if (opTok.kind !== "ident") throw new UnsupportedExpressionError("Expected operator");

    if (opTok.value === "in") {
      const inSet = this.parseInSet(getRaw);
      return supported ? inSet : this.unknownLeaf(fieldName);
    }

    const valTok = this.next();
    // Unsupported fields accept any single value token (e.g. IP literals)
    // so the leaf degrades to unknown instead of a parse failure.
    if (!supported) return this.unknownLeaf(fieldName);
    if (valTok.kind !== "string") throw new UnsupportedExpressionError("Expected string value");

    const cmp = buildComparator(opTok.value, getRaw, valTok.value);
    if (!cmp) {
      const detail = opTok.value === "matches" ? `${fieldName} (invalid regex)` : `operator ${opTok.value}`;
      return this.unknownLeaf(detail);
    }
    return cmp;
  }

  private parseInSet(getRaw: FieldGetter): TriPredicate {
    this.expect("lbrace");
    const set: string[] = [];
    for (let t = this.peek(); ; t = this.peek()) {
      if (!t) throw new UnsupportedExpressionError("Unterminated set");
      if (t.kind === "rbrace") {
        this.pos++;
        break;
      }
      if (t.kind !== "string") throw new UnsupportedExpressionError("Only string sets supported");
      set.push(t.value);
      this.pos++;
    }
    return (f) => set.includes(getRaw(f));
  }

  /** Operand inside starts_with/ends_with — a field, optionally lower(field). */
  private parseStringOperand(): { get: FieldGetter; supported: boolean; field: string } {
    const t = this.next();
    if (t.kind !== "ident") throw new UnsupportedExpressionError("Expected field");
    if (t.value === "lower") {
      this.expect("lparen");
      const inner = this.parseStringOperand();
      this.expect("rparen");
      return { ...inner, get: (f) => inner.get(f).toLowerCase() };
    }
    const name = t.value;
    return {
      get: (f) => fieldValue(name, f),
      supported: this.fieldSupported(name),
      field: name,
    };
  }
}

/**
 * Three-valued compile for the URL tester. Never throws: syntax errors
 * produce an always-unknown predicate flagged as unparseable.
 */
export function compileTriState(expression: string, options: CompileOptions = {}): TriCompiled {
  const trimmed = expression.trim();
  if (!trimmed) return { evaluate: () => true, unknownFields: [] };
  try {
    const parser = new Parser(tokenize(trimmed), options);
    const evaluate = parser.parse();
    return { evaluate, unknownFields: parser.unknownFields };
  } catch {
    return { evaluate: () => "unknown", unknownFields: ["unparseable expression"] };
  }
}

/**
 * Strict boolean compile for analytics attribution.
 * Throws UnsupportedExpressionError (naming the offending fields) when the
 * expression cannot be honestly evaluated from the available facts.
 */
export function compileExpression(expression: string, options: CompileOptions = {}): Predicate {
  const trimmed = expression.trim();
  if (!trimmed) return () => true;
  let parser: Parser;
  let evaluate: TriPredicate;
  try {
    parser = new Parser(tokenize(trimmed), options);
    evaluate = parser.parse();
  } catch {
    // Grammar the evaluator doesn't cover — surface a human-readable reason,
    // never the internal parse error ("Expected rparen" etc.).
    throw new UnsupportedExpressionError("syntax the built-in evaluator does not support");
  }
  if (parser.unknownFields.length > 0) {
    throw new UnsupportedExpressionError(parser.unknownFields.join(", "));
  }
  return (f) => evaluate(f) === true;
}

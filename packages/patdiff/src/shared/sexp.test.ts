import { describe, expect, it } from "vitest";
import { atom, list, parseSexp, parseSexpList, printSexp, SexpParseError } from "./sexp.js";

describe("parseSexp atoms", () => {
  it("unquoted atom", () => {
    expect(parseSexp("hello")).toEqual(atom("hello"));
  });

  it("quoted atom", () => {
    expect(parseSexp('"hello world"')).toEqual(atom("hello world"));
  });

  it("quoted atom with escapes", () => {
    expect(parseSexp('"a\\nb"')).toEqual(atom("a\nb"));
    expect(parseSexp('"a\\tb"')).toEqual(atom("a\tb"));
    expect(parseSexp('"a\\"b"')).toEqual(atom('a"b'));
    expect(parseSexp('"a\\\\b"')).toEqual(atom("a\\b"));
  });

  it("decimal escape", () => {
    expect(parseSexp('"\\065"')).toEqual(atom("A"));
  });

  it("hex escape", () => {
    expect(parseSexp('"\\x41"')).toEqual(atom("A"));
  });
});

describe("parseSexp lists", () => {
  it("empty list", () => {
    expect(parseSexp("()")).toEqual(list([]));
  });

  it("flat list", () => {
    expect(parseSexp("(a b c)")).toEqual(list([atom("a"), atom("b"), atom("c")]));
  });

  it("nested list", () => {
    expect(parseSexp("(a (b c) d)")).toEqual(list([atom("a"), list([atom("b"), atom("c")]), atom("d")]));
  });

  it("extra whitespace", () => {
    expect(parseSexp("  (  a   b\n c )  ")).toEqual(list([atom("a"), atom("b"), atom("c")]));
  });
});

describe("parseSexp comments", () => {
  it("line comment", () => {
    expect(parseSexp("(a ; comment\n b)")).toEqual(list([atom("a"), atom("b")]));
  });

  it("block comment", () => {
    expect(parseSexp("(a #| comment |# b)")).toEqual(list([atom("a"), atom("b")]));
  });

  it("nested block comment", () => {
    expect(parseSexp("(a #| outer #| inner |# still |# b)")).toEqual(list([atom("a"), atom("b")]));
  });
});

describe("parseSexp errors", () => {
  it("unterminated list", () => {
    expect(() => parseSexp("(a b")).toThrow(SexpParseError);
  });

  it("unterminated string", () => {
    expect(() => parseSexp('"abc')).toThrow(SexpParseError);
  });

  it("extra data after sexp", () => {
    expect(() => parseSexp("a b")).toThrow(SexpParseError);
  });

  it("stray close paren", () => {
    expect(() => parseSexp(")")).toThrow(SexpParseError);
  });

  it("empty input", () => {
    expect(() => parseSexp("")).toThrow(SexpParseError);
  });
});

describe("parseSexpList", () => {
  it("empty input gives empty list", () => {
    expect(parseSexpList("")).toEqual([]);
  });

  it("multiple top-level sexps", () => {
    expect(parseSexpList("(a) (b)")).toEqual([list([atom("a")]), list([atom("b")])]);
  });

  it("with comments between", () => {
    expect(parseSexpList("(a)\n;; comment\n(b)")).toEqual([list([atom("a")]), list([atom("b")])]);
  });
});

describe("printSexp", () => {
  it("plain atom unquoted", () => {
    expect(printSexp(atom("hello"))).toBe("hello");
  });

  it("atom with space gets quoted", () => {
    expect(printSexp(atom("hello world"))).toBe('"hello world"');
  });

  it("atom with parens gets quoted", () => {
    expect(printSexp(atom("(x)"))).toBe('"(x)"');
  });

  it("atom with semicolon gets quoted", () => {
    expect(printSexp(atom("a;b"))).toBe('"a;b"');
  });

  it("empty atom gets quoted", () => {
    expect(printSexp(atom(""))).toBe('""');
  });

  it("atom with quote escapes it", () => {
    expect(printSexp(atom('a"b'))).toBe('"a\\"b"');
  });

  it("atom with newline escapes it", () => {
    expect(printSexp(atom("a\nb"))).toBe('"a\\nb"');
  });

  it("list", () => {
    expect(printSexp(list([atom("a"), atom("b")]))).toBe("(a b)");
  });

  it("nested list with quoting", () => {
    expect(printSexp(list([atom("hello"), list([atom("a b"), atom("c")])]))).toBe('(hello ("a b" c))');
  });
});

describe("round-trip", () => {
  const samples: string[] = [
    "hello",
    "(a b c)",
    "(a (b c) d)",
    "()",
    '"hello world"',
    "(config (context 3) (keep-whitespace true))",
  ];

  for (const s of samples) {
    it(`round-trips ${s}`, () => {
      const parsed = parseSexp(s);
      const printed = printSexp(parsed);
      const reparsed = parseSexp(printed);
      expect(reparsed).toEqual(parsed);
    });
  }
});

describe("printSexp snapshot", () => {
  it("config example", () => {
    const s = list([
      atom("config"),
      list([atom("context"), atom("3")]),
      list([atom("rules"), list([atom("a b"), atom("c")])]),
    ]);
    expect(printSexp(s)).toMatchInlineSnapshot(`"(config (context 3) (rules ("a b" c)))"`);
  });
});

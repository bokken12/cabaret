import { expect, it } from "vitest";
import * as AnsiText from "../ansi-text.js";

const {
  parse,
  width,
  isEmpty,
  toString,
  toStringHum,
  map,
  simplifyStyles,
  styleAtEnd,
  split,
  visualize,
  Attr,
  Style,
  Text,
} = AnsiText;

it("width = String.length on boring strings", () => {
  const s = "Ansi_text.width = String.length on boring strings";
  expect(width(parse(s))).toBe(s.length);
});

it("ignore ANSI, including unknown codes, when computing width", () => {
  const t = parse("\x1b[0;31;123mfoo\x1b[F\x1b[31;42mbar\x1b[32;42mbaz\x1b[4i\x1b[0;32;42m");
  expect(width(t)).toMatchInlineSnapshot(`9`);
});

it("width calculations handle unicode", () => {
  const t = parse("\x1b[1;41m0123\x1b[2;32m4👋│👋5\x1b[4;64m6789\x1b[0m\x1b[E");
  expect(width(t)).toMatchInlineSnapshot(`15`);
});

it("a list with only ansi is empty", () => {
  const onlyStyles = parse("\x1b[10T\x1b[1;41m\x1b[2;32m\x1b[4;64m\x1b[0m");
  const withSpaces = parse("\x1b[1;41m \x1b[2;32m\x1b[4;64m \x1b[0m\x1b[10S");
  expect(isEmpty(onlyStyles)).toMatchInlineSnapshot(`true`);
  expect(isEmpty(withSpaces)).toMatchInlineSnapshot(`false`);
});

it("map over styles, controls, and texts", () => {
  let t = parse("\x1b[0;1;mfoo\x1b[2;3m  bar  \x1b[5;6mbaz\x1b[38;2;1;1;1;7m\x1b[3B\x1b[T\x1b[B");
  t = map(t, (e) => {
    if (e.kind === "Style") {
      const reset = Style.includesReset(e.style);
      return {
        kind: "Style",
        style: reset ? e.style : [Attr.Reset, ...e.style],
      };
    }
    return undefined;
  });
  t = map(t, (e) => {
    if (e.kind === "Control") {
      const c = e.value;
      if (c.kind === "CursorDown" && c.n !== undefined) {
        return {
          kind: "Control",
          value: { kind: "CursorDown", n: c.n + 1 },
        };
      }
    }
    return undefined;
  });
  t = map(t, (e) => {
    if (e.kind === "Text") {
      return { kind: "Text", text: Text.ofString(Text.toString(e.text).trim()) };
    }
    return undefined;
  });
  expect(toStringHum(t)).toMatchInlineSnapshot(
    `"(off +bold)foo(off +faint +italic)bar(off +blink +fastblink)baz(off fg:rgb256-1-1-1 +invert)(CursorDown:4)(ScrollDown)(CursorDown)"`,
  );
});

it("simplify_styles combines, shortens, and drops", () => {
  const t = parse("\x1b[0;1;m\x1b[2;3;mfoo\x1b[2;3m  bar  \x1b[5;6mbaz\x1b[38;2;1;1;1;7m");
  expect(toStringHum(simplifyStyles(t))).toMatchInlineSnapshot(
    `"(off +faint +italic)foo  bar  (+fastblink)baz(fg:rgb256-1-1-1 +invert)"`,
  );
});

it("get_style_at_end", () => {
  const str = "\x1b[2A\x1b[3;1;2;4;38;5;250m some \x1b[22;48;5;1m text \x1b[58;5;32m";
  expect(Style.toString(styleAtEnd(parse(str)))).toMatchInlineSnapshot(`"[3;4;38;5;250;22;41;58;5;32m"`);
});

it("get_style_at_end handles resets", () => {
  const s1 = "\x1b[1;2;3;4;38;5;250m some \x1b[K\x1b[2;48;5;1m text \x1b[0m";
  const s2 = "\x1b[1;2;3;4;38;5;250m some \x1b[5i\x1b[2;48;5;1;0m text \x1b[1m";
  expect(Style.toString(styleAtEnd(parse(s1)))).toMatchInlineSnapshot(`"[0m"`);
  expect(Style.toString(styleAtEnd(parse(s2)))).toMatchInlineSnapshot(`"[0;1m"`);
});

it("split in the middle", () => {
  const str = "\x1b[1;41m012345\x1b[2;32m6789ab\x1b[G\x1b[4;64mcdefgh\x1b[0m";
  const [before, after] = split(10, parse(str));
  const beforeStr = toString(before);
  const afterStr = toString(after);
  expect(beforeStr).toMatchInlineSnapshot(`"[1;41m012345[2;32m6789[49;22;39m"`);
  expect(afterStr).toMatchInlineSnapshot(`"[41;2;32mab[G[4;64mcdefgh[0m"`);
  expect(visualize(beforeStr)).toMatchInlineSnapshot(
    `"(+bold bg:red)012345(+faint fg:green)6789(bg:default -weight fg:default)"`,
  );
  expect(visualize(afterStr)).toMatchInlineSnapshot(
    `"(bg:red +faint fg:green)ab(CursorToCol:1)(+uline +ideogram:4)cdefgh(off)"`,
  );
});

it("split at a boundary", () => {
  const str = "\x1b[F\x1b[1;41m012345\x1b[2;32m6789ab\x1b[4;64mcdefgh\x1b[0m";
  const [before, after] = split(12, parse(str));
  const beforeStr = toString(before);
  const afterStr = toString(after);
  expect(beforeStr).toMatchInlineSnapshot(`"[F[1;41m012345[2;32m6789ab[49;22;39m"`);
  expect(afterStr).toMatchInlineSnapshot(`"[41;2;32;4;64mcdefgh[0m"`);
  expect(visualize(beforeStr)).toMatchInlineSnapshot(
    `"(CursorPrevLine)(+bold bg:red)012345(+faint fg:green)6789ab(bg:default -weight fg:default)"`,
  );
  expect(visualize(afterStr)).toMatchInlineSnapshot(`"(bg:red +faint fg:green +uline +ideogram:4)cdefgh(off)"`);
});

it("split resets others", () => {
  const str = "\x1b[1;41m some \x1b[2;32m more \x1b[1K\x1b[4;74m text \x1b[0m";
  const [before, after] = split(14, parse(str));
  const beforeStr = toString(before);
  const afterStr = toString(after);
  expect(beforeStr).toMatchInlineSnapshot(`"[1;41m some [2;32m more [1K[4;74m t[49;22;39;24;75m"`);
  expect(afterStr).toMatchInlineSnapshot(`"[41;2;32;4;74mext [0m"`);
  expect(visualize(beforeStr)).toMatchInlineSnapshot(
    `"(+bold bg:red) some (+faint fg:green) more (EraseLine:ToStart)(+uline +subscript) t(bg:default -weight fg:default -uline -script)"`,
  );
  expect(visualize(afterStr)).toMatchInlineSnapshot(`"(bg:red +faint fg:green +uline +subscript)ext (off)"`);
});

it("split handles unicode", () => {
  const str = "\x1b[1;41m\x1b[2J0123\x1b[2;32m4👋👋5\x1b[4;74m6789\x1b[0m";
  const [before, after] = split(7, parse(str));
  expect(width(before)).toMatchInlineSnapshot(`7`);
  expect(width(after)).toMatchInlineSnapshot(`7`);
  const beforeStr = toString(before);
  const afterStr = toString(after);
  expect(beforeStr).toMatchInlineSnapshot(`"[1;41m[2J0123[2;32m4👋[49;22;39m"`);
  expect(afterStr).toMatchInlineSnapshot(`"[41;2;32m👋5[4;74m6789[0m"`);
  expect(visualize(beforeStr)).toMatchInlineSnapshot(
    `"(+bold bg:red)(EraseScreen)0123(+faint fg:green)4👋(bg:default -weight fg:default)"`,
  );
  expect(visualize(afterStr)).toMatchInlineSnapshot(`"(bg:red +faint fg:green)👋5(+uline +subscript)6789(off)"`);
});

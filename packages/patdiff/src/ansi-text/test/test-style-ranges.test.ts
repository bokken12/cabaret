import { expect, it } from "vitest";
import * as AnsiText from "../ansi-text.js";

const { parse, Text_with_style_ranges, Style_ranges, Text, Attr, Color } = AnsiText;

const { ofTextWithAnsi, toUnstyled, toStringHum, unstyleBetween, split } = Text_with_style_ranges;

const expectSome = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected Some");
  return v;
};

it("find ranges in a patdiff body", () => {
  const diff =
    "\x1b[41;30m-\x1b[49;39m\x1b[0m\x1b[90m(** The wire\x1b[39m\x1b[1;31m kind\x1b[22;39m\x1b[90m of a bricks log *)\x1b[39m\n" +
    "\x1b[41;30m-\x1b[49;39m\x1b[0m\x1b[90mval\x1b[39m\x1b[1;31m kind\x1b[22;39m\x1b[90m : Log_wire.wire_\x1b[39m\x1b[1;31mkind\x1b[22;39m\n" +
    "\x1b[42;30m+\x1b[49;39m\x1b[0m(** The wire\x1b[32m class\x1b[39m of a bricks log *)\n" +
    "\x1b[42;30m+\x1b[49;39m\x1b[0mval\x1b[32m wire_class\x1b[39m : Log_wire.wire_\x1b[32mclass\x1b[39m";
  const withRanges = expectSome(ofTextWithAnsi(parse(diff)));
  expect(toUnstyled(withRanges)).toMatchInlineSnapshot(`
    "-(** The wire kind of a bricks log *)
    -val kind : Log_wire.wire_kind
    +(** The wire class of a bricks log *)
    +val wire_class : Log_wire.wire_class"
  `);
  expect(toStringHum(withRanges)).toMatchInlineSnapshot(`
    "(bg:red fg:black)-(bg:default fg:default)(fg:gray)(off)(** The wire(fg:default)(+bold fg:red) kind(-weight fg:default)(fg:gray) of a bricks log *)
    (fg:default)(bg:red fg:black)-(bg:default fg:default)(fg:gray)val(fg:default)(+bold fg:red) kind(-weight fg:default)(fg:gray) : Log_wire.wire_(fg:default)(+bold fg:red)kind
    (-weight fg:default)(bg:green fg:black)+(bg:default fg:default)(off)(** The wire(fg:green) class(fg:default) of a bricks log *)
    (bg:green fg:black)+(bg:default fg:default)val(fg:green) wire_class(fg:default) : Log_wire.wire_(fg:green)class(fg:default)"
  `);
});

const header =
  "\x1b[1;94m@@@@@@@@\x1b[22;39m      \x1b[35mView 1/1 : feature-ddiff\x1b[39m      \x1b[1;94m@@@@@@@@\x1b[22;39m\n" +
  "\x1b[1;94m@@@@@@@@\x1b[22;39m \x1b[1;48;2;80;40;80;37m--\x1b[22;49;39m \x1b[1mdiff of\x1b[22m \x1b[31mold base\x1b[39m \x1b[1m/\x1b[22m \x1b[32mold tip\x1b[39m \x1b[1m1,44\x1b[22m \x1b[1;94m@@@@@@@@\x1b[22;39m\n" +
  "\x1b[1;94m@@@@@@@@\x1b[22;39m \x1b[1;48;2;20;60;120;37m++\x1b[22;49;39m \x1b[1mdiff of\x1b[22m \x1b[31mnew base\x1b[39m \x1b[1m/\x1b[22m \x1b[32mnew tip\x1b[39m \x1b[1m1,31\x1b[22m \x1b[1;94m@@@@@@@@\x1b[22;39m";

it("find ranges in a patdiff4 header", () => {
  const withRanges = expectSome(ofTextWithAnsi(parse(header)));
  expect(toUnstyled(withRanges)).toMatchInlineSnapshot(`
    "@@@@@@@@      View 1/1 : feature-ddiff      @@@@@@@@
    @@@@@@@@ -- diff of old base / old tip 1,44 @@@@@@@@
    @@@@@@@@ ++ diff of new base / new tip 1,31 @@@@@@@@"
  `);
  expect(toStringHum(withRanges)).toMatchInlineSnapshot(`
    "(+bold fg:bright-blue)@@@@@@@@(-weight fg:default)      (fg:magenta)View 1/1 : feature-ddiff(fg:default)      (+bold fg:bright-blue)@@@@@@@@
    (-weight fg:default)(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:rgb256-80-40-80 fg:white)--(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)old base(fg:default) (+bold)/(-weight) (fg:green)old tip(fg:default) (+bold)1,44(-weight) (+bold fg:bright-blue)@@@@@@@@
    (-weight fg:default)(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:rgb256-20-60-120 fg:white)++(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)new base(fg:default) (+bold)/(-weight) (fg:green)new tip(fg:default) (+bold)1,31(-weight) (+bold fg:bright-blue)@@@@@@@@(-weight fg:default)"
  `);
});

it("apply", () => {
  const text = Text.ofString("some uninteresting text");
  const style = [Attr.Bold, Attr.Italic, Attr.Bg(Color.Bright("Magenta")), Attr.Fg(Color.Bright("Green"))];
  const range = [{ start: 5, end_: 18, style }];
  const styledText = Style_ranges.apply(text, range);
  expect(AnsiText.toStringHum(styledText)).toMatchInlineSnapshot(
    `"some (+bold +italic bg:bright-magenta fg:bright-green)uninteresting(-weight -italic bg:default fg:default) text"`,
  );
});

it("unstyle_between", () => {
  const styled = expectSome(ofTextWithAnsi(parse(header)));
  const partiallyStyled = unstyleBetween(52, 104, styled);
  expect(toStringHum(partiallyStyled)).toMatchInlineSnapshot(`
    "(+bold fg:bright-blue)@@@@@@@@(-weight fg:default)      (fg:magenta)View 1/1 : feature-ddiff(fg:default)      (+bold fg:bright-blue)@@@@@@@@
    (-weight fg:default)@@@@@@@@ -- diff of old base / old tip 1,44 @@@@@@@@
    (+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:rgb256-20-60-120 fg:white)++(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)new base(fg:default) (+bold)/(-weight) (fg:green)new tip(fg:default) (+bold)1,31(-weight) (+bold fg:bright-blue)@@@@@@@@(-weight fg:default)"
  `);
});

it("split", () => {
  const [first, second] = split(52, expectSome(ofTextWithAnsi(parse(header))));
  expect(toStringHum(first)).toMatchInlineSnapshot(`
    "(+bold fg:bright-blue)@@@@@@@@(-weight fg:default)      (fg:magenta)View 1/1 : feature-ddiff(fg:default)      (+bold fg:bright-blue)@@@@@@@@
    (-weight fg:default)"
  `);
  expect(toStringHum(second)).toMatchInlineSnapshot(`
    "(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:rgb256-80-40-80 fg:white)--(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)old base(fg:default) (+bold)/(-weight) (fg:green)old tip(fg:default) (+bold)1,44(-weight) (+bold fg:bright-blue)@@@@@@@@
    (-weight fg:default)(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:rgb256-20-60-120 fg:white)++(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)new base(fg:default) (+bold)/(-weight) (fg:green)new tip(fg:default) (+bold)1,31(-weight) (+bold fg:bright-blue)@@@@@@@@(-weight fg:default)"
  `);
});

it("find ranges in side-by-side patdiff4 output", () => {
  const diff =
    "\x1b[1;48;2;200;100;0;37m!!\x1b[22;49;39m\x1b[41;30m-\x1b[49;39m\x1b[0m\x1b[90mval\x1b[39m\x1b[1;31m kind\x1b[22;39m\x1b[90m :\x1b[48;2;80;40;80m B.Log\x1b[49m.wire_\x1b[39m\x1b[1;31mkind\x1b[22;39m               │\x1b[1;48;2;200;100;0;37m!!\x1b[22;49;39m\x1b[41;30m-\x1b[49;39m\x1b[0m\x1b[90mval\x1b[39m\x1b[1;31m kind\x1b[22;39m\x1b[90m :\x1b[48;2;20;60;120m Log_wire\x1b[49m.wire_\x1b[39m\x1b[1;31mkind\x1b[22;39m\n" +
    "\x1b[1;48;2;200;100;0;37m!!\x1b[22;49;39m\x1b[42;30m+\x1b[49;39m\x1b[0mval\x1b[32m wire_class\x1b[39m :\x1b[48;2;80;40;80m B.Log\x1b[49m.wire_\x1b[32mclass\x1b[39m        │\x1b[1;48;2;200;100;0;37m!!\x1b[22;49;39m\x1b[42;30m+\x1b[49;39m\x1b[0mval\x1b[32m wire_class\x1b[39m :\x1b[48;2;20;60;120m Log_wire\x1b[49m.wire_\x1b[32mclass\x1b[39m";
  const withRanges = expectSome(ofTextWithAnsi(parse(diff)));
  expect(toUnstyled(withRanges)).toMatchInlineSnapshot(`
    "!!-val kind : B.Log.wire_kind               │!!-val kind : Log_wire.wire_kind
    !!+val wire_class : B.Log.wire_class        │!!+val wire_class : Log_wire.wire_class"
  `);
  expect(
    withRanges.ranges.map((r) => ({ start: r.start, end_: r.end_, attrs: r.style.length })),
  ).toMatchInlineSnapshot(`
      [
        {
          "attrs": 3,
          "end_": 2,
          "start": 0,
        },
        {
          "attrs": 2,
          "end_": 3,
          "start": 2,
        },
        {
          "attrs": 1,
          "end_": 6,
          "start": 3,
        },
        {
          "attrs": 1,
          "end_": 48,
          "start": 3,
        },
        {
          "attrs": 2,
          "end_": 11,
          "start": 6,
        },
        {
          "attrs": 1,
          "end_": 25,
          "start": 11,
        },
        {
          "attrs": 1,
          "end_": 19,
          "start": 13,
        },
        {
          "attrs": 2,
          "end_": 29,
          "start": 25,
        },
        {
          "attrs": 3,
          "end_": 47,
          "start": 45,
        },
        {
          "attrs": 2,
          "end_": 48,
          "start": 47,
        },
        {
          "attrs": 1,
          "end_": 51,
          "start": 48,
        },
        {
          "attrs": 2,
          "end_": 56,
          "start": 51,
        },
        {
          "attrs": 1,
          "end_": 73,
          "start": 56,
        },
        {
          "attrs": 1,
          "end_": 67,
          "start": 58,
        },
        {
          "attrs": 2,
          "end_": 77,
          "start": 73,
        },
        {
          "attrs": 3,
          "end_": 79,
          "start": 77,
        },
        {
          "attrs": 2,
          "end_": 80,
          "start": 79,
        },
        {
          "attrs": 1,
          "end_": 125,
          "start": 80,
        },
        {
          "attrs": 1,
          "end_": 94,
          "start": 83,
        },
        {
          "attrs": 1,
          "end_": 102,
          "start": 96,
        },
        {
          "attrs": 1,
          "end_": 113,
          "start": 108,
        },
        {
          "attrs": 3,
          "end_": 124,
          "start": 122,
        },
        {
          "attrs": 2,
          "end_": 125,
          "start": 124,
        },
        {
          "attrs": 1,
          "end_": 139,
          "start": 128,
        },
        {
          "attrs": 1,
          "end_": 150,
          "start": 141,
        },
        {
          "attrs": 1,
          "end_": 161,
          "start": 156,
        },
      ]
    `);
});

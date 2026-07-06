import { describe, expect, it } from "vitest";
import * as AnsiText from "../ansi-text.js";

const { parse, visualize, minimize, strip, apply, toString, Style, Attr, Color } = AnsiText;

const escString = (s: string): string => {
  // Mimic OCaml's String.escaped: ESC -> \027, other printables stay.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    if (code === 0x5c) out += "\\\\";
    else if (code === 0x22) out += '\\"';
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0d) out += "\\r";
    else if (code >= 0x20 && code <= 0x7e) out += c;
    else out += `\\${code.toString().padStart(3, "0")}`;
  }
  return out;
};

it("simple visualize", () => {
  expect(visualize("\x1b[31mfoo\x1b[0m")).toMatchInlineSnapshot(`"(fg:red)foo(off)"`);
});

it("ESC[m is equivalent to ESC[0m (reset)", () => {
  expect(visualize("\x1b[mfoo\x1b[0m")).toMatchInlineSnapshot(`"(off)foo(off)"`);
});

it("visualize includes unknown codes", () => {
  expect(visualize("\x1b[6nfoo\x1b[110m")).toMatchInlineSnapshot(`"(ANSI-CSI:6n)foo(ANSI-SGR:110)"`);
});

it("simple minimize", () => {
  expect(minimize("\x1b[0;31mfoo")).toMatchInlineSnapshot(`"[0;31mfoo"`);
});

it("minimize resets", () => {
  const s = "a \x1b[0m line of text \x1b[0;0;0m\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"a (off) line of text (off off off)(off)"`);
  expect(minimize(s)).toMatchInlineSnapshot(`"a [0m line of text "`);
  expect(visualize(minimize(s))).toMatchInlineSnapshot(`"a (off) line of text "`);
});

it("minimize with newlines", () => {
  const s = "a \x1b[0m line of text\n\x1b[0m\n\x1b[1;2mline after skip\n\x1b[0;0m\x1b[0m!\n";
  expect(visualize(s)).toMatchInlineSnapshot(`
    "a (off) line of text
    (off)
    (+bold +faint)line after skip
    (off off)(off)!
    "
  `);
  expect(minimize(s)).toMatchInlineSnapshot(`
    "a [0m line of text

    [2mline after skip
    [0m!
    "
  `);
  expect(visualize(minimize(s))).toMatchInlineSnapshot(`
    "a (off) line of text

    (+faint)line after skip
    (off)!
    "
  `);
});

it("strip out ANSI codes that are later overridden by a reset", () => {
  const s = "\x1b[0m\x1b[31m\x1b[0m\x1b[32m\x1b[42mf\x1b[44moo\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(off)(fg:red)(off)(fg:green)(bg:green)f(bg:blue)oo(off)"`);
  expect(minimize(s)).toMatchInlineSnapshot(`"[0;32;42mf[44moo[0m"`);
  expect(visualize(minimize(s))).toMatchInlineSnapshot(`"(off fg:green bg:green)f(bg:blue)oo(off)"`);
});

it("combine and simplify adjacent ANSI codes", () => {
  expect(minimize("\x1b[0;44m\x1b[0;31m\x1b[1;32;44mfoo")).toMatchInlineSnapshot(`"[0;1;32;44mfoo"`);
});

it("ignore a repeated style even with a reset", () => {
  const str = "  \x1b[0;41;30mabc\x1b[0;2mdef\x1b[A\x1b[A\x1b[0;1;2mghi\x1b[0m";
  expect(visualize(str)).toMatchInlineSnapshot(
    `"  (off bg:red fg:black)abc(off +faint)def(ANSI-CSI:A)(ANSI-CSI:A)(off +bold +faint)ghi(off)"`,
  );
  expect(minimize(str)).toMatchInlineSnapshot(`"  [0;41;30mabc[0;2mdef[A[Aghi[0m"`);
  expect(visualize(minimize(str))).toMatchInlineSnapshot(
    `"  (off bg:red fg:black)abc(off +faint)def(ANSI-CSI:A)(ANSI-CSI:A)ghi(off)"`,
  );
});

it("strip out styles that are redundant with earlier codes", () => {
  expect(minimize("\x1b[0;31mfoo\x1b[31;42mbar\x1b[32;42mbaz\x1b[0;32;42m")).toMatchInlineSnapshot(
    `"[0;31mfoo[42mbar[32mbaz"`,
  );
});

it("strip all ANSI codes", () => {
  expect(strip("\x1b[0m\x1b[31m\x1b[0m\x1b[5D\x1b[32m\x1b[42mf\x1b[44mo\x1b[Bo\x1b[0m")).toMatchInlineSnapshot(`"foo"`);
});

it("strip known & unknown CSI codes", () => {
  const s = "\x1b[0;31;123mfoo\x1b[31;42mbar\x1b[32;42Qbaz\x1b[0;32;42m\x1b[0;32~;42m";
  expect(strip(s)).toMatchInlineSnapshot(`"foobarbaz;42m"`);
});

it("preserve malformed CSI sequences as text", () => {
  const s = "before\x1b[123\x1b[31mafter";
  expect(visualize(s)).toMatchInlineSnapshot(`"before(ANSI-Fe:[)123(fg:red)after"`);
  expect(strip(s)).toMatchInlineSnapshot(`"before123after"`);
});

it("compress unknown codes", () => {
  expect(minimize("\x1b[11;12mfoo\x1b[10;51;52mbar\x1b[54;52m")).toMatchInlineSnapshot(`"[12mfoo[10;52mbar"`);
});

it("all the attributes", () => {
  const s = "\x1b[1;2;3;4;5;7;8;9;21;53;31;41;53mfoo\x1b[22;23;24;25;27;28;29;55;39;49;59mbar\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(
    `"(+bold +faint +italic +uline +blink +invert +hide +strike +2uline +overline fg:red bg:red +overline)foo(-weight -italic -uline -blink -invert -hide -strike -overline fg:default bg:default ul:default)bar(off)"`,
  );
  expect(minimize(s)).toMatchInlineSnapshot(`"[2;3;5;7;8;9;21;31;41;53mfoo[22;23;24;25;27;28;29;55;39;49;59mbar[0m"`);
});

it("apply turns on and off but doesn't simplify", () => {
  const str = "some \x1b[2;48;5;1m\x1b[1K text";
  const style = Style.ofSgrParams([1, 2, 3, 4, 38, 5, 250]);
  const styled = apply(style, str);
  expect(styled).toMatchInlineSnapshot(`"[1;2;3;4;38;5;250msome [2;48;5;1m[1K text[22;23;24;39m"`);
  expect(minimize(styled)).toMatchInlineSnapshot(`"[2;3;4;38;5;250msome [41m[1K text[22;23;24;39m"`);
});

it("handle a patdiff header", () => {
  const s =
    "\x1b[1;94m@@@@@@@@\x1b[22;39m \x1b[1;45;37m--\x1b[22;49;39m \x1b[1mdiff of\x1b[0m " +
    "\x1b[31m/home/username/sbs/da_ob\x1b[39m \x1b[1m&\x1b[22m " +
    "\x1b[32m/home/us\x1b[0m│\x1b[1;94m@@@@@@@@\x1b[22;39m \x1b[1;46;37m++\x1b[22;49;39m " +
    "\x1b[1mdiff of\x1b[22m \x1b[31m/home/username/sbs/da_nb\x1b[39m \x1b[1m&\x1b[22m " +
    "\x1b[32m/home/us\x1b[0m";
  const m = minimize(s);
  expect(strip(s)).toMatchInlineSnapshot(
    `"@@@@@@@@ -- diff of /home/username/sbs/da_ob & /home/us│@@@@@@@@ ++ diff of /home/username/sbs/da_nb & /home/us"`,
  );
  expect(strip(m)).toMatchInlineSnapshot(
    `"@@@@@@@@ -- diff of /home/username/sbs/da_ob & /home/us│@@@@@@@@ ++ diff of /home/username/sbs/da_nb & /home/us"`,
  );
  expect(visualize(s)).toMatchInlineSnapshot(
    `"(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:magenta fg:white)--(-weight bg:default fg:default) (+bold)diff of(off) (fg:red)/home/username/sbs/da_ob(fg:default) (+bold)&(-weight) (fg:green)/home/us(off)│(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:cyan fg:white)++(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)/home/username/sbs/da_nb(fg:default) (+bold)&(-weight) (fg:green)/home/us(off)"`,
  );
  expect(visualize(m)).toMatchInlineSnapshot(
    `"(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:magenta fg:white)--(-weight bg:default fg:default) (+bold)diff of(off) (fg:red)/home/username/sbs/da_ob(fg:default) (+bold)&(-weight) (fg:green)/home/us(off)│(+bold fg:bright-blue)@@@@@@@@(-weight fg:default) (+bold bg:cyan fg:white)++(-weight bg:default fg:default) (+bold)diff of(-weight) (fg:red)/home/username/sbs/da_nb(fg:default) (+bold)&(-weight) (fg:green)/home/us(off)"`,
  );
});

it("center a patdiff header", () => {
  const header = parse(" \x1b[1mdiff of\x1b[22m \x1b[31mold base\x1b[39m and \x1b[32mold tip\x1b[39m ");
  const style = [Attr.Bold, Attr.Fg(Color.Bright("Blue"))];
  const centered = AnsiText.center(header, { char: "@", style, width: 80 });
  expect(toString(centered)).toMatchInlineSnapshot(
    `"[1;94m@@@@@@@@@@@@@@@@@@@@@@@@@[22;39m [1mdiff of[22m [31mold base[39m and [32mold tip[39m [1;94m@@@@@@@@@@@@@@@@@@@@@@@@@[22;39m"`,
  );
  expect(AnsiText.toStringHum(centered)).toMatchInlineSnapshot(
    `"(+bold fg:bright-blue)@@@@@@@@@@@@@@@@@@@@@@@@@(-weight fg:default) (+bold)diff of(-weight) (fg:red)old base(fg:default) and (fg:green)old tip(fg:default) (+bold fg:bright-blue)@@@@@@@@@@@@@@@@@@@@@@@@@(-weight fg:default)"`,
  );
});

it("a line that was wonky in a patdiff test", () => {
  const str = "    \x1b[0;41;30m-|\x1b[0;2m    let per_date_by_date,\x1b[0;2m error_by_date =\x1b[0m";
  expect(visualize(minimize(str))).toMatchInlineSnapshot(
    `"    (off bg:red fg:black)-|(off +faint)    let per_date_by_date, error_by_date =(off)"`,
  );
});

it("another line that was wonky in a patdiff test", () => {
  const str = "    │2 \x1b[0;41;30m-|\x1b[0m\x1b[0;31m\x1b[0m\x1b[0;31m_\x1b[0m    ";
  expect(minimize(str)).toMatchInlineSnapshot(`"    │2 [0;41;30m-|[0;31m_[0m    "`);
  expect(visualize(minimize(str))).toMatchInlineSnapshot(`"    │2 (off bg:red fg:black)-|(off fg:red)_(off)    "`);
});

it("split handles unicode", () => {
  const str = "\x1b[1;41m0123\x1b[2;32m4👋👋5\x1b[4;64m6789\x1b[0m";
  const [before, after] = AnsiText.split(7, parse(str));
  const beforeStr = toString(before);
  const afterStr = toString(after);
  expect(beforeStr).toMatchInlineSnapshot(`"[1;41m0123[2;32m4👋[49;22;39m"`);
  expect(afterStr).toMatchInlineSnapshot(`"[41;2;32m👋5[4;64m6789[0m"`);
  expect(visualize(beforeStr)).toMatchInlineSnapshot(
    `"(+bold bg:red)0123(+faint fg:green)4👋(bg:default -weight fg:default)"`,
  );
  expect(visualize(afterStr)).toMatchInlineSnapshot(`"(bg:red +faint fg:green)👋5(+uline +ideogram:4)6789(off)"`);
  expect(strip(beforeStr)).toMatchInlineSnapshot(`"01234👋"`);
  expect(strip(afterStr)).toMatchInlineSnapshot(`"👋56789"`);
});

it("OSC 8 hyperlinks", () => {
  const s = "\x1b]8;;https://example.com\x1b\\clickable text\x1b]8;;\x1b\\";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:8;;https://example.com)clickable text(ANSI-OSC:8;;)"`);
  expect(minimize(s)).toMatchInlineSnapshot(`"]8;;https://example.com\\clickable text]8;;\\"`);
  expect(strip(s)).toMatchInlineSnapshot(`"clickable text"`);
});

it("OSC 8 hyperlink with bold text", () => {
  const s = "\x1b]8;;https://example.com\x1b\\\x1b[1mbold link\x1b[0m\x1b]8;;\x1b\\";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:8;;https://example.com)(+bold)bold link(off)(ANSI-OSC:8;;)"`);
  expect(minimize(s)).toMatchInlineSnapshot(`"]8;;https://example.com\\[1mbold link[0m]8;;\\"`);
  expect(strip(s)).toMatchInlineSnapshot(`"bold link"`);
});

it("OSC 8 hyperlink with colored text", () => {
  const s =
    "\x1b]8;;https://example.com\x1b\\\x1b[31mred link\x1b[0m\x1b]8;;\x1b\\ and " +
    "\x1b]8;;https://other.com\x1b\\\x1b[42mgreen link\x1b[49m\x1b]8;;\x1b\\";
  expect(visualize(s)).toMatchInlineSnapshot(
    `"(ANSI-OSC:8;;https://example.com)(fg:red)red link(off)(ANSI-OSC:8;;) and (ANSI-OSC:8;;https://other.com)(bg:green)green link(bg:default)(ANSI-OSC:8;;)"`,
  );
  expect(minimize(s)).toMatchInlineSnapshot(
    `"]8;;https://example.com\\[31mred link[0m]8;;\\ and ]8;;https://other.com\\[42mgreen link[49m]8;;\\"`,
  );
  expect(strip(s)).toMatchInlineSnapshot(`"red link and green link"`);
});

describe("parse |> to_string appropriately preserves input", () => {
  const roundTrip = (s: string): string => escString(toString(parse(s)));
  it("plain text", () => {
    expect(roundTrip("plain text")).toMatchInlineSnapshot(`"plain text"`);
  });
  it("red", () => {
    expect(roundTrip("\x1b[31mred\x1b[0m")).toMatchInlineSnapshot(`"\\027[31mred\\027[0m"`);
  });
  it("bold bright red", () => {
    expect(roundTrip("\x1b[1;38;5;196mbold bright red\x1b[0m")).toMatchInlineSnapshot(
      `"\\027[1;38;5;196mbold bright red\\027[0m"`,
    );
  });
  it("OSC 8", () => {
    expect(roundTrip("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toMatchInlineSnapshot(
      `"\\027]8;;https://example.com\\027\\\\link\\027]8;;\\027\\\\"`,
    );
  });
  it("CSI with tilde", () => {
    expect(roundTrip("\x1b[0;32~;42m")).toMatchInlineSnapshot(`"\\027[0;32~;42m"`);
  });
  it("before bold after", () => {
    expect(roundTrip("before\x1b[1mbold\x1b[0mafter")).toMatchInlineSnapshot(`"before\\027[1mbold\\027[0mafter"`);
  });
  it("multiple styles", () => {
    expect(roundTrip("\x1b[1m\x1b[31m\x1b[42m")).toMatchInlineSnapshot(`"\\027[1m\\027[31m\\027[42m"`);
  });
  it("text ESC", () => {
    expect(roundTrip("text\x1b")).toMatchInlineSnapshot(`"text\\027"`);
  });
  it("ESC c", () => {
    expect(roundTrip("\x1bc")).toMatchInlineSnapshot(`"\\027c"`);
  });
});

describe("ESC handling: structure and roundtripping", () => {
  const test = (s: string): string => {
    const parsed = parse(s);
    const serialized = toString(parsed);
    let out = "";
    out += `input:      ${escString(s)}\n`;
    out += `serialized: ${escString(serialized)}\n`;
    if (s !== serialized) out += "not equivalent!";
    out += visualize(s);
    return out;
  };

  it("ESC at end of input", () => {
    expect(test("text\x1b")).toMatchInlineSnapshot(`
      "input:      text\\027
      serialized: text\\027
      text(ESC)"
    `);
  });

  it("ESC followed by ESC", () => {
    expect(test("\x1b\x1b")).toMatchInlineSnapshot(`
      "input:      \\027\\027
      serialized: \\027\\027
      (ESC)(ESC)"
    `);
  });

  it("ESC-CSI-ESC", () => {
    expect(test("\x1b\x1b[31m\x1b")).toMatchInlineSnapshot(`
      "input:      \\027\\027[31m\\027
      serialized: \\027\\027[31m\\027
      (ESC)(fg:red)(ESC)"
    `);
  });

  it("Simple Fe escape sequence", () => {
    expect(test("\x1bc")).toMatchInlineSnapshot(`
      "input:      \\027c
      serialized: \\027c
      (ANSI-Fp:c)"
    `);
  });

  it("Multiple Fe escapes followed by text", () => {
    expect(test("\x1bsome\x1btext")).toMatchInlineSnapshot(`
      "input:      \\027some\\027text
      serialized: \\027some\\027text
      (ANSI-Fp:s)ome(ANSI-Fp:t)ext"
    `);
  });

  it("nF escape sequences", () => {
    expect(test("before\x1b Fbetween\x1b(Bafter")).toMatchInlineSnapshot(`
      "input:      before\\027 Fbetween\\027(Bafter
      serialized: before\\027 Fbetween\\027(Bafter
      before(ANSI-nF: F)between(ANSI-nF:(B)after"
    `);
  });
});

describe("CSI with non-alpha final bytes", () => {
  const test = (s: string): readonly [string, string] => [visualize(s), escString(toString(parse(s)))];

  it("@", () => {
    expect(test("\x1b[1@")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:1@)",
        "\\027[1@",
      ]
    `);
  });
  it("~", () => {
    expect(test("\x1b[1~")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:1~)",
        "\\027[1~",
      ]
    `);
  });
  it("backtick", () => {
    expect(test("\x1b[5`")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:5\`)",
        "\\027[5\`",
      ]
    `);
  });
});

describe("CSI with out-of-range parameters becomes Unknown", () => {
  const test = (s: string): readonly [string, string] => [visualize(s), escString(toString(parse(s)))];

  it("valid EraseDisplay", () => {
    expect(test("\x1b[2J")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:2J)",
        "\\027[2J",
      ]
    `);
  });
  it("invalid EraseDisplay", () => {
    expect(test("\x1b[5J")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:5J)",
        "\\027[5J",
      ]
    `);
  });
  it("valid EraseLine", () => {
    expect(test("\x1b[2K")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:2K)",
        "\\027[2K",
      ]
    `);
  });
  it("invalid EraseLine", () => {
    expect(test("\x1b[5K")).toMatchInlineSnapshot(`
      [
        "(ANSI-CSI:5K)",
        "\\027[5K",
      ]
    `);
  });
});

it("SGR with out-of-range 256-color code", () => {
  const s = "\x1b[38;5;300mtext\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-SGR:38;5;300)text(off)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[38;5;300mtext\\027[0m"`);
});

it("SGR with unknown color type", () => {
  const s = "\x1b[38;3;1;2;3mtext\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-SGR:38 +italic +bold +faint +italic)text(off)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[38;3;1;2;3mtext\\027[0m"`);
});

it("multiple valid codes interleaved with unknown codes", () => {
  const s = "\x1b[1;110;31;38;5;300;4mtext\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(+bold ANSI-SGR:110 fg:red ANSI-SGR:38;5;300 +uline)text(off)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[1;110;31;38;5;300;4mtext\\027[0m"`);
});

it("complex SGR: many RGB colors", () => {
  const s = "\x1b[38;2;255;0;0;48;2;0;255;0;58;2;0;0;255mtext\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(fg:rgb256-255-0-0 bg:rgb256-0-255-0 ul:rgb256-0-0-255)text(off)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(
    `"\\027[38;2;255;0;0;48;2;0;255;0;58;2;0;0;255mtext\\027[0m"`,
  );
});

it("unterminated OSC followed by CSI", () => {
  const s = "\x1b]8;;url\x1b[31mred\x1b[0m";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-Fe:])8;;url(fg:red)red(off)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]8;;url\\027[31mred\\027[0m"`);
});

it("private mode sequences - show/hide cursor", () => {
  const s = "\x1b[?25hvisible\x1b[?25l";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:?25h)visible(ANSI-CSI:?25l)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[?25hvisible\\027[?25l"`);
});

it("private mode sequences - alternate screen", () => {
  const s = "\x1b[?1049hALT\x1b[?1049l";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:?1049h)ALT(ANSI-CSI:?1049l)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[?1049hALT\\027[?1049l"`);
});

it("private mode sequences - old alternate screen", () => {
  const s = "\x1b[?47hALT\x1b[?47l";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:?47h)ALT(ANSI-CSI:?47l)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[?47hALT\\027[?47l"`);
});

it("private mode sequences - bracketed paste", () => {
  const s = "\x1b[?2004htext\x1b[?2004l";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:?2004h)text(ANSI-CSI:?2004l)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[?2004htext\\027[?2004l"`);
});

it("private mode sequences - multiple modes", () => {
  const s = "\x1b[?25;47htext\x1b[?25;47l";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:?25;47h)text(ANSI-CSI:?25;47l)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[?25;47htext\\027[?25;47l"`);
});

it("DSR sequences - cursor position query", () => {
  const s = "\x1b[6n";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:6n)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[6n"`);
});

it("DSR sequences - device status query", () => {
  const s = "\x1b[5n";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:5n)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[5n"`);
});

it("DSR sequences - other numeric query", () => {
  const s = "\x1b[0n";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-CSI:0n)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027[0n"`);
});

it("OSC sequences - window title with BEL", () => {
  const s = "\x1b]0;my window title\x07";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:0;my window title)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]0;my window title\\007"`);
});

it("OSC sequences - window title with ST", () => {
  const s = "\x1b]2;another title\x1b\\";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:2;another title)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]2;another title\\027\\\\"`);
});

it("OSC sequences - icon name", () => {
  const s = "\x1b]1;my icon\x07";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:1;my icon)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]1;my icon\\007"`);
});

it("OSC sequences - working directory", () => {
  const s = "\x1b]7;file:///home/user\x07";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:7;file:///home/user)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]7;file:///home/user\\007"`);
});

it("OSC sequences - other/unknown", () => {
  const s = "\x1b]99;some payload\x07";
  expect(visualize(s)).toMatchInlineSnapshot(`"(ANSI-OSC:99;some payload)"`);
  expect(escString(toString(parse(s)))).toMatchInlineSnapshot(`"\\027]99;some payload\\007"`);
});

/** Translation of OCaml [test_side_by_side.ml]. The original test driver prints
 *  both Wrapped and Truncated outputs to stdout, optionally with [Ansi_text.visualize]
 *  showing the ANSI colors as inline tags. We mirror that by joining both outputs
 *  into a single string for snapshot assertion.
 *
 *  Acceptable drift from OCaml ground truth:
 *  - Trailing whitespace on wrap-break lines (e.g. the leftmost-pane content lines that
 *    end at the pane boundary) is preserved literally in the TS snapshots. OCaml's
 *    [%expect] blocks strip these trailing spaces from display, but the actual
 *    byte stream from [output_to_string_side_by_side] in both implementations
 *    matches character-for-character. */

import { describe, expect, it } from "vitest";
import * as AnsiText from "../ansi-text/ansi-text.js";
import { ok } from "../shared/result.js";
import { splitLines } from "../shared/string-util.js";
import { ansiOutput } from "./ansi-output.js";
import { asciiOutput } from "./ascii-output.js";
import * as FileName from "./file-name.js";
import * as Format from "./format.js";
import { withoutMtime as htmlWithoutMtime } from "./html-output.js";
import type { Output, S as OutputS } from "./output.js";
import { make } from "./patdiff-core.js";

const lineBigEnough = 3;
const wordBigEnough = 3;

const buildPatdiff = (terminalWidth: number) =>
  make({
    // Report a console width one larger than [terminalWidth] so that, when the
    // caller passes [widthOverride = terminalWidth], OCaml's production [output_width]
    // does *not* subtract one (the guard [override >= console] is false). This
    // reproduces OCaml's test-mode ([am_running_test = true]) output.
    consoleWidth: () => ok(terminalWidth + 1),
    implementation: (t: Output): OutputS => {
      switch (t) {
        case "Ansi":
          return ansiOutput;
        case "Ascii":
          return asciiOutput;
        case "Html":
          return htmlWithoutMtime;
      }
    },
  });

const formatTest = (args: {
  prev: string;
  next: string;
  terminalWidth?: number;
  includeColors?: boolean;
  markNewlineChanges?: boolean;
}): string => {
  const terminalWidth = Math.max(args.terminalWidth ?? 125, 121);
  const includeColors = args.includeColors ?? false;
  const markNewlineChanges = args.markNewlineChanges ?? true;
  const patdiff = buildPatdiff(terminalWidth);

  const prev = splitLines(args.prev);
  const next = splitLines(args.next);
  const hunks = patdiff.diff({
    context: -1,
    lineBigEnough,
    keepWs: false,
    findMoves: true,
    prev,
    next,
  });
  const refined = patdiff.refineStructured({
    markNewlineChanges,
    produceUnifiedLines: false,
    keepWs: false,
    splitLongLines: false,
    wordBigEnough,
    interleave: true,
    hunks,
  });
  const rules = Format.Rules.defaultRules;
  const half = Math.floor((terminalWidth - 1) / 2);
  const divider = "-".repeat(half) + "│" + "-".repeat(half);

  // OCaml's test mode (am_running_test = true) suppresses the [override - 1]
  // subtraction in [output_width]. TS doesn't have an [am_running_test] flag, so
  // we pass [widthOverride < consoleWidth] to defeat the production subtraction
  // and reproduce OCaml's test-mode output verbatim.
  const widthOverride = terminalWidth;
  const renderBlock = (handleColors: (s: string) => string): string => {
    const wrapped = patdiff.outputToStringSideBySide({
      widthOverride,
      fileNames: [FileName.fake("before"), FileName.fake("after")],
      rules,
      wrapOrTruncate: "wrap",
      output: "Ansi",
      hunks: refined,
    });
    const truncated = patdiff.outputToStringSideBySide({
      widthOverride,
      fileNames: [FileName.fake("before"), FileName.fake("after")],
      rules,
      wrapOrTruncate: "truncate",
      output: "Ansi",
      hunks: refined,
    });
    return ["Wrapped", divider, handleColors(wrapped), "Truncated", divider, handleColors(truncated)].join("\n");
  };

  const stripped = renderBlock(AnsiText.strip);
  if (!includeColors) return stripped;
  return stripped + "\n\n" + renderBlock(AnsiText.visualize);
};

describe("test_side_by_side", () => {
  it("dogs are best vs cutest, single line replace", () => {
    const prev = `
a
b
cats
dogs are the best pets to have and there's absolutely no debating it. everyone agrees (at least everyone who counts!)
elephant
f
g
h
i
j
k
`;
    const next = `
a
b
cats
dogs are the cutest pets to have
elephant
f
g
h
i
j
k
`;
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   a                                                        │ 2   a
       3   b                                                        │ 3   b
       4   cats                                                     │ 4   cats
       5 !|dogs are the best pets to have and there's absolutely no │ 5 !|dogs are the cutest pets to have
           debating it. everyone agrees (at least everyone who count│
           s!)                                                      │
       6   elephant                                                 │ 6   elephant
       7   f                                                        │ 7   f
       8   g                                                        │ 8   g
       9   h                                                        │ 9   h
      10   i                                                        │10   i
      11   j                                                        │11   j
      12   k                                                        │12   k
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   a                                                        │ 2   a
       3   b                                                        │ 3   b
       4   cats                                                     │ 4   cats
       5 !|dogs are the best pets to have and there's absolutely no │ 5 !|dogs are the cutest pets to have
       6   elephant                                                 │ 6   elephant
       7   f                                                        │ 7   f
       8   g                                                        │ 8   g
       9   h                                                        │ 9   h
      10   i                                                        │10   i
      11   j                                                        │11   j
      12   k                                                        │12   k

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                   │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
       1                                                            │ 1
       2   a                                                        │ 2   a
       3   b                                                        │ 3   b
       4   cats                                                     │ 4   cats
       5 (+bold fg:yellow)!|(-weight fg:default)dogs are the(fg:red) best(fg:default) pets to have(fg:red) and there's absolutely no (fg:default)│ 5 (+bold fg:yellow)!|(-weight fg:default)dogs are the(fg:green) cutest(fg:default) pets to have
           (fg:red)debating it. everyone agrees (at least everyone who count(fg:default)│
           (fg:red)s!)(fg:default)                                                      │
       6   elephant                                                 │ 6   elephant
       7   f                                                        │ 7   f
       8   g                                                        │ 8   g
       9   h                                                        │ 9   h
      10   i                                                        │10   i
      11   j                                                        │11   j
      12   k                                                        │12   k
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                   │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
       1                                                            │ 1
       2   a                                                        │ 2   a
       3   b                                                        │ 3   b
       4   cats                                                     │ 4   cats
       5 (+bold fg:yellow)!|(-weight fg:default)dogs are the(fg:red) best(fg:default) pets to have(fg:red) and there's absolutely no (fg:default)│ 5 (+bold fg:yellow)!|(-weight fg:default)dogs are the(fg:green) cutest(fg:default) pets to have
       6   elephant                                                 │ 6   elephant
       7   f                                                        │ 7   f
       8   g                                                        │ 8   g
       9   h                                                        │ 9   h
      10   i                                                        │10   i
      11   j                                                        │11   j
      12   k                                                        │12   k"
    `);
  });

  it("two completely different files", () => {
    expect(
      formatTest({
        prev: "These two files",
        next: "are completely different",
        terminalWidth: 125,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|These two files                                           │
                                                                    │1 +|are completely different
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|These two files                                           │
                                                                    │1 +|are completely different

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)These two files(fg:default)                                           │
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)are completely different(fg:default)
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)These two files(fg:default)                                           │
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)are completely different(fg:default)"
    `);
  });

  it("small change wrap/truncate variations", () => {
    expect(
      formatTest({
        prev: "Line with a small change",
        next: "Line with small change",
        terminalWidth: 125,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|Line with a small change                                  │1 !|Line with small change
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|Line with a small change                                  │1 !|Line with small change

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                  │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                  │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change"
    `);

    expect(
      formatTest({
        prev: "Line with a small change but we need it to be long enough that it will wrap",
        next: "Line with small change but we need it to be long enough that it will wrap",
        terminalWidth: 120,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change but we need it to be long enoug│1 !|Line with small change but we need it to be long enough
          h that it will wrap                                     │    that it will wrap
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change but we need it to be long enoug│1 !|Line with small change but we need it to be long enough

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change but we need it to be long enoug│1 (+bold fg:yellow)!|(-weight fg:default)Line with small change but we need it to be long enough
          h that it will wrap                                     │    that it will wrap
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change but we need it to be long enoug│1 (+bold fg:yellow)!|(-weight fg:default)Line with small change but we need it to be long enough"
    `);

    expect(
      formatTest({
        prev: "Line with a small change",
        next: "Line with small change",
        terminalWidth: 55,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change                                │1 !|Line with small change
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change                                │1 !|Line with small change

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change"
    `);

    expect(
      formatTest({
        prev: "Line with a small change",
        next: "Line with small change",
        terminalWidth: 50,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change                                │1 !|Line with small change
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|Line with a small change                                │1 !|Line with small change

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)Line with(fg:red) a(fg:default) small change                                │1 (+bold fg:yellow)!|(-weight fg:default)Line with small change"
    `);
  });

  it("middle line deleted", () => {
    expect(
      formatTest({
        prev: `
The quick brown fox
The rain in Spain
Veni vidi vici
`,
        next: `
The quick brown fox
Veni vidi vici
`,
        terminalWidth: 125,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1                                                             │1
      2   The quick brown fox                                       │2   The quick brown fox
      3 -|The rain in Spain                                         │
      4   Veni vidi vici                                            │3   Veni vidi vici
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1                                                             │1
      2   The quick brown fox                                       │2   The quick brown fox
      3 -|The rain in Spain                                         │
      4   Veni vidi vici                                            │3   Veni vidi vici

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1                                                             │1
      2   The quick brown fox                                       │2   The quick brown fox
      3 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)The rain in Spain(fg:default)                                         │
      4   Veni vidi vici                                            │3   Veni vidi vici
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1                                                             │1
      2   The quick brown fox                                       │2   The quick brown fox
      3 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)The rain in Spain(fg:default)                                         │
      4   Veni vidi vici                                            │3   Veni vidi vici"
    `);
  });

  it("test unicode", () => {
    expect(
      formatTest({
        prev: "测试一二三",
        next: "测试一三",
        terminalWidth: 125,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|测试一二三                                                │
                                                                    │1 +|测试一三
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|测试一二三                                                │
                                                                    │1 +|测试一三

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)测试一二三(fg:default)                                                │
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)测试一三(fg:default)
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)测试一二三(fg:default)                                                │
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)测试一三(fg:default)"
    `);
  });

  it("test first word deleted", () => {
    expect(
      formatTest({
        prev: "bananas are good",
        next: "are good",
        terminalWidth: 125,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|bananas are good                                          │1 !|are good
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|bananas are good                                          │1 !|are good

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)(fg:red)bananas(fg:default) are good                                          │1 (+bold fg:yellow)!|(-weight fg:default)are good
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)(fg:red)bananas(fg:default) are good                                          │1 (+bold fg:yellow)!|(-weight fg:default)are good"
    `);
    expect(
      formatTest({
        prev: "bananas are good",
        next: "are good",
        terminalWidth: 16,
        includeColors: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|bananas are good                                        │1 !|are good
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|bananas are good                                        │1 !|are good

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)(fg:red)bananas(fg:default) are good                                        │1 (+bold fg:yellow)!|(-weight fg:default)are good
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)(fg:red)bananas(fg:default) are good                                        │1 (+bold fg:yellow)!|(-weight fg:default)are good"
    `);
  });

  it("test first word added", () => {
    const prev = "are goooooooooooooooooooooooooooooooooooooooooooood";
    const next = "bananas are goooooooooooooooooooooooooooooooooooooooooooood";
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|are goooooooooooooooooooooooooooooooooooooooooooood       │1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooooo
                                                                    │    d
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|are goooooooooooooooooooooooooooooooooooooooooooood       │1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooooo

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)are goooooooooooooooooooooooooooooooooooooooooooood       │1 (+bold fg:yellow)!|(-weight fg:default)(fg:green)bananas(fg:default) are gooooooooooooooooooooooooooooooooooooooooooooo
                                                                    │    d
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)are goooooooooooooooooooooooooooooooooooooooooooood       │1 (+bold fg:yellow)!|(-weight fg:default)(fg:green)bananas(fg:default) are gooooooooooooooooooooooooooooooooooooooooooooo"
    `);
    expect(formatTest({ prev, next, terminalWidth: 16, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|are goooooooooooooooooooooooooooooooooooooooooooood     │1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooo
                                                                  │    ood
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|are goooooooooooooooooooooooooooooooooooooooooooood     │1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooo

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)are goooooooooooooooooooooooooooooooooooooooooooood     │1 (+bold fg:yellow)!|(-weight fg:default)(fg:green)bananas(fg:default) are gooooooooooooooooooooooooooooooooooooooooooo
                                                                  │    ood
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)are goooooooooooooooooooooooooooooooooooooooooooood     │1 (+bold fg:yellow)!|(-weight fg:default)(fg:green)bananas(fg:default) are gooooooooooooooooooooooooooooooooooooooooooo"
    `);
  });

  it("test word deleted in middle", () => {
    const prev = "bananas are goooooooooooooooooooooooooooooooooooooooooooood";
    const next = "bananas goooooooooooooooooooooooooooooooooooooooooooood";
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooooo│1 !|bananas goooooooooooooooooooooooooooooooooooooooooooood
          d                                                         │
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooooo│1 !|bananas goooooooooooooooooooooooooooooooooooooooooooood

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)bananas(fg:red) are(fg:default) gooooooooooooooooooooooooooooooooooooooooooooo│1 (+bold fg:yellow)!|(-weight fg:default)bananas goooooooooooooooooooooooooooooooooooooooooooood
          d                                                         │
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)bananas(fg:red) are(fg:default) gooooooooooooooooooooooooooooooooooooooooooooo│1 (+bold fg:yellow)!|(-weight fg:default)bananas goooooooooooooooooooooooooooooooooooooooooooood"
    `);
    expect(formatTest({ prev, next, terminalWidth: 16, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooo│1 !|bananas goooooooooooooooooooooooooooooooooooooooooooood
          ood                                                     │
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 !|bananas are gooooooooooooooooooooooooooooooooooooooooooo│1 !|bananas goooooooooooooooooooooooooooooooooooooooooooood

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)bananas(fg:red) are(fg:default) gooooooooooooooooooooooooooooooooooooooooooo│1 (+bold fg:yellow)!|(-weight fg:default)bananas goooooooooooooooooooooooooooooooooooooooooooood
          ood                                                     │
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:yellow)!|(-weight fg:default)bananas(fg:red) are(fg:default) gooooooooooooooooooooooooooooooooooooooooooo│1 (+bold fg:yellow)!|(-weight fg:default)bananas goooooooooooooooooooooooooooooooooooooooooooood"
    `);
  });

  it("test whole line deleted", () => {
    const prev = `12345 12345 12345 12345 12345 12345 12345 12345 12345 12345 12345
678910
`;
    const next = "678910";
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|12345 12345 12345 12345 12345 12345 12345 12345 12345 1234│
          5 12345                                                   │
      2   678910                                                    │1   678910
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1 -|12345 12345 12345 12345 12345 12345 12345 12345 12345 1234│
      2   678910                                                    │1   678910

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)12345 12345 12345 12345 12345 12345 12345 12345 12345 1234(fg:default)│
          (fg:red)5 12345(fg:default)                                                   │
      2   678910                                                    │1   678910
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)12345 12345 12345 12345 12345 12345 12345 12345 12345 1234(fg:default)│
      2   678910                                                    │1   678910"
    `);
    expect(formatTest({ prev, next, terminalWidth: 16, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 -|12345 12345 12345 12345 12345 12345 12345 12345 12345 12│
          345 12345                                               │
      2   678910                                                  │1   678910
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
      1 -|12345 12345 12345 12345 12345 12345 12345 12345 12345 12│
      2   678910                                                  │1   678910

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)12345 12345 12345 12345 12345 12345 12345 12345 12345 12(fg:default)│
          (fg:red)345 12345(fg:default)                                               │
      2   678910                                                  │1   678910
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1 (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)(fg:red)12345 12345 12345 12345 12345 12345 12345 12345 12345 12(fg:default)│
      2   678910                                                  │1   678910"
    `);
  });

  it("test whole line added", () => {
    const prev = "678910";
    const next = `12345 12345 12345 12345 12345 12345 12345 12345 12345 12345 12345
678910
`;
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
                                                                    │1 +|12345 12345 12345 12345 12345 12345 12345 12345 12345 1234
                                                                    │    5 12345
      1   678910                                                    │2   678910
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
                                                                    │1 +|12345 12345 12345 12345 12345 12345 12345 12345 12345 1234
      1   678910                                                    │2   678910

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)12345 12345 12345 12345 12345 12345 12345 12345 12345 1234(fg:default)
                                                                    │    (fg:green)5 12345(fg:default)
      1   678910                                                    │2   678910
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                    │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                    │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)12345 12345 12345 12345 12345 12345 12345 12345 12345 1234(fg:default)
      1   678910                                                    │2   678910"
    `);
    expect(formatTest({ prev, next, terminalWidth: 16, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
                                                                  │1 +|12345 12345 12345 12345 12345 12345 12345 12345 12345 12
                                                                  │    345 12345
      1   678910                                                  │2   678910
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        -|before                                                  │  +|after
                                                                  │1 +|12345 12345 12345 12345 12345 12345 12345 12345 12345 12
      1   678910                                                  │2   678910

      Wrapped
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                  │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)12345 12345 12345 12345 12345 12345 12345 12345 12345 12(fg:default)
                                                                  │    (fg:green)345 12345(fg:default)
      1   678910                                                  │2   678910
      Truncated
      ------------------------------------------------------------│------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                  │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                  │1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)12345 12345 12345 12345 12345 12345 12345 12345 12345 12(fg:default)
      1   678910                                                  │2   678910"
    `);
  });

  it("Make sure first word of replace block is formatted correctly", () => {
    const prev = `
ABC
1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
21 22 23 24 25
MNO
`;
    const next = `
ABC
1 2 3 4 5 6 7 8
new line
new 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
MNO
`;
    expect(formatTest({ prev, next, terminalWidth: 140, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ---------------------------------------------------------------------│---------------------------------------------------------------------
        -|before                                                           │  +|after
      1                                                                    │1
      2   ABC                                                              │2   ABC
      3 !|1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20               │3 !|1 2 3 4 5 6 7 8
                                                                           │4 +|new line
      4 !|21 22 23 24 25                                                   │5 !|new 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
      5   MNO                                                              │6   MNO
      Truncated
      ---------------------------------------------------------------------│---------------------------------------------------------------------
        -|before                                                           │  +|after
      1                                                                    │1
      2   ABC                                                              │2   ABC
      3 !|1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20               │3 !|1 2 3 4 5 6 7 8
                                                                           │4 +|new line
      4 !|21 22 23 24 25                                                   │5 !|new 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
      5   MNO                                                              │6   MNO

      Wrapped
      ---------------------------------------------------------------------│---------------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                           │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1                                                                    │1
      2   ABC                                                              │2   ABC
      3 (+bold fg:yellow)!|(-weight fg:default)1 2 3 4 5 6 7 8(fg:red) 9(fg:default) 10 11 12 13 14 15 16 17 18 19 20(fg:red)(fg:default)               │3 (+bold fg:yellow)!|(-weight fg:default)1 2 3 4 5 6 7 8(fg:green)(fg:default)
                                                                           │4 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)new line(fg:default)
      4 (+bold fg:yellow)!|(-weight fg:default)(fg:red)(fg:default)21 22 23 24 25                                                   │5 (+bold fg:yellow)!|(-weight fg:default)(fg:green)new(fg:default) 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
      5   MNO                                                              │6   MNO
      Truncated
      ---------------------------------------------------------------------│---------------------------------------------------------------------
        (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                           │  (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
      1                                                                    │1
      2   ABC                                                              │2   ABC
      3 (+bold fg:yellow)!|(-weight fg:default)1 2 3 4 5 6 7 8(fg:red) 9(fg:default) 10 11 12 13 14 15 16 17 18 19 20(fg:red)(fg:default)               │3 (+bold fg:yellow)!|(-weight fg:default)1 2 3 4 5 6 7 8(fg:green)(fg:default)
                                                                           │4 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)new line(fg:default)
      4 (+bold fg:yellow)!|(-weight fg:default)(fg:red)(fg:default)21 22 23 24 25                                                   │5 (+bold fg:yellow)!|(-weight fg:default)(fg:green)new(fg:default) 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
      5   MNO                                                              │6   MNO"
    `);
  });

  it("Test html output", () => {
    const prev = `
ABC
1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
21 22 23 24 25
MNO
`;
    const next = `
ABC
1 2 3 4 5 6 7 8
new line
new 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
MNO
`;
    const prevLines = splitLines(prev);
    const nextLines = splitLines(next);
    const patdiff = buildPatdiff(125);
    const hunks = patdiff.diff({
      context: -1,
      lineBigEnough,
      keepWs: false,
      findMoves: true,
      prev: prevLines,
      next: nextLines,
    });
    const refined = patdiff.refineStructured({
      produceUnifiedLines: false,
      keepWs: false,
      splitLongLines: false,
      wordBigEnough,
      interleave: true,
      hunks,
    });
    const out = patdiff.outputToStringSideBySide({
      widthOverride: 100,
      fileNames: [FileName.fake("a"), FileName.fake("b")],
      rules: Format.Rules.defaultRules,
      wrapOrTruncate: "wrap",
      output: "Html",
      hunks: refined,
    });
    expect(out).toMatchInlineSnapshot(`
      "  <span style="color:#880000"><span style="font-weight:bold">-|</span></span><span style="color:#880000"></span>a                                                │  <span style="color:#008800"><span style="font-weight:bold">+|</span></span><span style="color:#008800"></span>b
      1                                                           │1
      2   ABC                                                     │2   ABC
      3 <span style="color:#888800"><span style="font-weight:bold">!|</span></span>1 2 3 4 5 6 7 8<span style="color:#880000"> 9</span> 10 11 12 13 14 15 16 17 18 19 20<span style="color:#880000"></span>      │3 <span style="color:#888800"><span style="font-weight:bold">!|</span></span>1 2 3 4 5 6 7 8<span style="color:#008800"></span>
                                                                  │4 <span style="color:#008800"><span style="font-weight:bold">+|</span></span><span style="color:#008800"></span><span style="color:#008800">new line</span>
      4 <span style="color:#888800"><span style="font-weight:bold">!|</span></span><span style="color:#880000"></span>21 22 23 24 25                                          │5 <span style="color:#888800"><span style="font-weight:bold">!|</span></span><span style="color:#008800">new</span> 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
      5   MNO                                                     │6   MNO"
    `);
  });

  it("test move (no colors)", () => {
    const prev = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce sit amet
malesuada leo. Vivamus vitae orci quis justo ornare molestie. Donec fringilla
tempus magna, ut semper lacus tincidunt at. Suspendisse et rutrum arcu. Aliquam
erat volutpat. Pellentesque pretium pellentesque elit, a consequat metus
placerat a. Praesent hendrerit euismod sem nec facilisis. Curabitur finibus ex
sagittis massa blandit, et dictum lectus lobortis. Sed fringilla fringilla
tortor vel finibus. Sed vel tortor pulvinar, fermentum quam non, blandit lorem.

Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.
`;
    const next = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce sit amet
malesuada leo. Vivamus vitae orci quis justo ornare molestie. Donec fringilla
tempus magna, ut semper lacus tincidunt at. Suspendisse et rutrum arcu. Aliquam
erat volutpat. Pellentesque pretium pellentesque elit, a consequat metus
placerat a. Praesent hendrerit euismod sem nec facilisis. Curabitur finibus ex
sagittis massa blandit, et dictum lectus lobortis. Sed fringilla fringilla
tortor vel finibus. Sed vel tortor pulvinar, fermentum quam non, blandit lorem.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.


Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.
`;
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: false })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   Lorem ipsum dolor sit amet, consectetur adipiscing elit. │ 2   Lorem ipsum dolor sit amet, consectetur adipiscing elit.
           Fusce sit amet                                           │     Fusce sit amet
       3   malesuada leo. Vivamus vitae orci quis justo ornare moles│ 3   malesuada leo. Vivamus vitae orci quis justo ornare moles
           tie. Donec fringilla                                     │     tie. Donec fringilla
       4   tempus magna, ut semper lacus tincidunt at. Suspendisse e│ 4   tempus magna, ut semper lacus tincidunt at. Suspendisse e
           t rutrum arcu. Aliquam                                   │     t rutrum arcu. Aliquam
       5   erat volutpat. Pellentesque pretium pellentesque elit, a │ 5   erat volutpat. Pellentesque pretium pellentesque elit, a
           consequat metus                                          │     consequat metus
       6   placerat a. Praesent hendrerit euismod sem nec facilisis.│ 6   placerat a. Praesent hendrerit euismod sem nec facilisis.
            Curabitur finibus ex                                    │      Curabitur finibus ex
       7   sagittis massa blandit, et dictum lectus lobortis. Sed fr│ 7   sagittis massa blandit, et dictum lectus lobortis. Sed fr
           ingilla fringilla                                        │     ingilla fringilla
       8   tortor vel finibus. Sed vel tortor pulvinar, fermentum qu│ 8   tortor vel finibus. Sed vel tortor pulvinar, fermentum qu
           am non, blandit lorem.                                   │     am non, blandit lorem.
                                                                    │ 9 >|
                                                                    │10 >|Cras non semper ante. Vivamus non nulla scelerisque, ferm
                                                                    │     entum sem at, laoreet
                                                                    │11 >|est. Sed convallis, magna sit amet maximus sollicitudin, 
                                                                    │     nulla metus sodales
                                                                    │12 >|eros, eu molestie arcu urna ut nunc. Pellentesque habitan
                                                                    │     t morbi tristique
                                                                    │13 >|senectus et netus et malesuada fames ac turpis egestas. M
                                                                    │     orbi sollicitudin,
                                                                    │14 >|turpis sit amet ultricies interdum, urna nisl rhoncus tel
                                                                    │     lus, id consectetur
                                                                    │15 >|tellus lobortis laoreet. Donec fringilla lacinia nulla si
                                                                    │     t amet eleifend.
                                                                    │16 >|Suspendisse iaculis metus sed massa bibendum, quis conseq
                                                                    │     uat metus lacinia.
                                                                    │17 >|Etiam scelerisque odio nec pulvinar dapibus. Duis interdu
                                                                    │     m interdum quam vel
                                                                    │18 >|dapibus. Quisque dapibus nisl quis magna accumsan, et lob
                                                                    │     ortis magna eleifend.
                                                                    │19 >|Ut venenatis cursus diam, vel dictum augue interdum vitae
                                                                    │     . Ut scelerisque
                                                                    │20 >|condimentum augue, eget bibendum augue lacinia in.
                                                                    │21 +|
       9                                                            │22
      10   Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ul│23   Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ul
           tricies eu, pretium et                                   │     tricies eu, pretium et
      11   elit. Duis bibendum aliquet quam et tempor. Donec quis da│24   elit. Duis bibendum aliquet quam et tempor. Donec quis da
           pibus justo. Praesent                                    │     pibus justo. Praesent
      12   eget pellentesque nisi. Nulla vestibulum orci quis dui la│25   eget pellentesque nisi. Nulla vestibulum orci quis dui la
           oreet, eget posuere sem                                  │     oreet, eget posuere sem
      13   interdum. Morbi ac sodales ligula. Proin arcu ipsum, vene│26   interdum. Morbi ac sodales ligula. Proin arcu ipsum, vene
           natis id cursus et,                                      │     natis id cursus et,
      14   blandit eu mi. Sed iaculis egestas ligula, lacinia condim│27   blandit eu mi. Sed iaculis egestas ligula, lacinia condim
           entum velit commodo                                      │     entum velit commodo
      15   non. In eu elit convallis, tempus sapien sed, maximus pur│28   non. In eu elit convallis, tempus sapien sed, maximus pur
           us. Sed vitae enim et                                    │     us. Sed vitae enim et
      16   tellus accumsan bibendum eu vel turpis. Phasellus massa l│29   tellus accumsan bibendum eu vel turpis. Phasellus massa l
           eo, eleifend vel                                         │     eo, eleifend vel
      17   tincidunt ut, consequat et est. Duis quis condimentum ex.│30   tincidunt ut, consequat et est. Duis quis condimentum ex.
            Etiam nec faucibus                                      │      Etiam nec faucibus
      18   lorem. Aliquam vehicula porta sapien, ut aliquam purus cu│31   lorem. Aliquam vehicula porta sapien, ut aliquam purus cu
           rsus vitae. Nullam at                                    │     rsus vitae. Nullam at
      19   ex vehicula, egestas sapien vitae, molestie ipsum.       │32   ex vehicula, egestas sapien vitae, molestie ipsum.
      20                                                            │33
      21   Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifen│34   Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifen
           d fermentum iaculis.                                     │     d fermentum iaculis.
      22   Duis dignissim, mi sit amet vehicula auctor, odio mauris │35   Duis dignissim, mi sit amet vehicula auctor, odio mauris
           consectetur lectus, ac                                   │     consectetur lectus, ac
      23   tincidunt lorem diam a nisi. Duis vehicula ex ac tortor s│36   tincidunt lorem diam a nisi. Duis vehicula ex ac tortor s
           agittis, ac commodo                                      │     agittis, ac commodo
      24   lectus venenatis. Nam efficitur justo eros, et ornare neq│37   lectus venenatis. Nam efficitur justo eros, et ornare neq
           ue aliquet ut. Duis                                      │     ue aliquet ut. Duis
      25   vulputate nulla nunc, eget pellentesque diam aliquam at. │38   vulputate nulla nunc, eget pellentesque diam aliquam at.
           Cras rhoncus orci at                                     │     Cras rhoncus orci at
      26   tortor posuere convallis sed sed risus. Quisque sed ipsum│39   tortor posuere convallis sed sed risus. Quisque sed ipsum
            ex.                                                     │      ex.
      27 <|                                                         │
      28 <|Cras non semper ante. Vivamus non nulla scelerisque, ferm│
           entum sem at, laoreet                                    │
      29 <|est. Sed convallis, magna sit amet maximus sollicitudin, │
           nulla metus sodales                                      │
      30 <|eros, eu molestie arcu urna ut nunc. Pellentesque habitan│
           t morbi tristique                                        │
      31 <|senectus et netus et malesuada fames ac turpis egestas. M│
           orbi sollicitudin,                                       │
      32 <|turpis sit amet ultricies interdum, urna nisl rhoncus tel│
           lus, id consectetur                                      │
      33 <|urna risus ut arcu. Aliquam hendrerit eros id ex tempor v│
           ehicula. Nunc a pretium                                  │
      34 <|risus. Nulla tincidunt, mauris eu pellentesque hendrerit,│
            nisi nibh volutpat                                      │
      35 <|sapien, vitae vehicula lacus tellus dictum augue. Pellent│
           esque malesuada vitae                                    │
      36 <|tellus lobortis laoreet. Donec fringilla lacinia nulla si│
           t amet eleifend.                                         │
      37 <|Suspendisse iaculis metus sed massa bibendum, quis conseq│
           uat metus lacinia.                                       │
      38 <|Etiam scelerisque odio nec pulvinar dapibus. Duis interdu│
           m interdum quam vel                                      │
      39 <|dapibus. Quisque dapibus nisl quis magna accumsan, et lob│
           ortis magna eleifend.                                    │
      40 <|Ut venenatis cursus diam, vel dictum augue interdum vitae│
           . Ut scelerisque                                         │
      41 <|condimentum augue, eget bibendum augue lacinia in.       │
      42                                                            │40
      43   Aenean porta elit vitae pharetra dapibus. Duis a odio neq│41   Aenean porta elit vitae pharetra dapibus. Duis a odio neq
           ue. Curabitur                                            │     ue. Curabitur
      44   ullamcorper enim ut metus luctus, eu blandit augue consec│42   ullamcorper enim ut metus luctus, eu blandit augue consec
           tetur. Vestibulum                                        │     tetur. Vestibulum
      45   blandit lorem eget blandit fringilla. In et libero non la│43   blandit lorem eget blandit fringilla. In et libero non la
           cus elementum pulvinar                                   │     cus elementum pulvinar
      46   id a orci. Maecenas porta urna mollis, egestas lacus id, │44   id a orci. Maecenas porta urna mollis, egestas lacus id,
           feugiat nisi. Vivamus                                    │     feugiat nisi. Vivamus
      47   imperdiet ornare dui eleifend semper. Integer erat ipsum,│45   imperdiet ornare dui eleifend semper. Integer erat ipsum,
            vestibulum a lobortis                                   │      vestibulum a lobortis
      48   eu, posuere in orci. Pellentesque gravida in purus eu ull│46   eu, posuere in orci. Pellentesque gravida in purus eu ull
           amcorper. Nunc urna                                      │     amcorper. Nunc urna
      49   tortor, hendrerit nec eleifend et, dapibus sed dolor.    │47   tortor, hendrerit nec eleifend et, dapibus sed dolor.
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   Lorem ipsum dolor sit amet, consectetur adipiscing elit. │ 2   Lorem ipsum dolor sit amet, consectetur adipiscing elit.
       3   malesuada leo. Vivamus vitae orci quis justo ornare moles│ 3   malesuada leo. Vivamus vitae orci quis justo ornare moles
       4   tempus magna, ut semper lacus tincidunt at. Suspendisse e│ 4   tempus magna, ut semper lacus tincidunt at. Suspendisse e
       5   erat volutpat. Pellentesque pretium pellentesque elit, a │ 5   erat volutpat. Pellentesque pretium pellentesque elit, a
       6   placerat a. Praesent hendrerit euismod sem nec facilisis.│ 6   placerat a. Praesent hendrerit euismod sem nec facilisis.
       7   sagittis massa blandit, et dictum lectus lobortis. Sed fr│ 7   sagittis massa blandit, et dictum lectus lobortis. Sed fr
       8   tortor vel finibus. Sed vel tortor pulvinar, fermentum qu│ 8   tortor vel finibus. Sed vel tortor pulvinar, fermentum qu
                                                                    │ 9 >|
                                                                    │10 >|Cras non semper ante. Vivamus non nulla scelerisque, ferm
                                                                    │11 >|est. Sed convallis, magna sit amet maximus sollicitudin, 
                                                                    │12 >|eros, eu molestie arcu urna ut nunc. Pellentesque habitan
                                                                    │13 >|senectus et netus et malesuada fames ac turpis egestas. M
                                                                    │14 >|turpis sit amet ultricies interdum, urna nisl rhoncus tel
                                                                    │15 >|tellus lobortis laoreet. Donec fringilla lacinia nulla si
                                                                    │16 >|Suspendisse iaculis metus sed massa bibendum, quis conseq
                                                                    │17 >|Etiam scelerisque odio nec pulvinar dapibus. Duis interdu
                                                                    │18 >|dapibus. Quisque dapibus nisl quis magna accumsan, et lob
                                                                    │19 >|Ut venenatis cursus diam, vel dictum augue interdum vitae
                                                                    │20 >|condimentum augue, eget bibendum augue lacinia in.
                                                                    │21 +|
       9                                                            │22
      10   Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ul│23   Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ul
      11   elit. Duis bibendum aliquet quam et tempor. Donec quis da│24   elit. Duis bibendum aliquet quam et tempor. Donec quis da
      12   eget pellentesque nisi. Nulla vestibulum orci quis dui la│25   eget pellentesque nisi. Nulla vestibulum orci quis dui la
      13   interdum. Morbi ac sodales ligula. Proin arcu ipsum, vene│26   interdum. Morbi ac sodales ligula. Proin arcu ipsum, vene
      14   blandit eu mi. Sed iaculis egestas ligula, lacinia condim│27   blandit eu mi. Sed iaculis egestas ligula, lacinia condim
      15   non. In eu elit convallis, tempus sapien sed, maximus pur│28   non. In eu elit convallis, tempus sapien sed, maximus pur
      16   tellus accumsan bibendum eu vel turpis. Phasellus massa l│29   tellus accumsan bibendum eu vel turpis. Phasellus massa l
      17   tincidunt ut, consequat et est. Duis quis condimentum ex.│30   tincidunt ut, consequat et est. Duis quis condimentum ex.
      18   lorem. Aliquam vehicula porta sapien, ut aliquam purus cu│31   lorem. Aliquam vehicula porta sapien, ut aliquam purus cu
      19   ex vehicula, egestas sapien vitae, molestie ipsum.       │32   ex vehicula, egestas sapien vitae, molestie ipsum.
      20                                                            │33
      21   Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifen│34   Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifen
      22   Duis dignissim, mi sit amet vehicula auctor, odio mauris │35   Duis dignissim, mi sit amet vehicula auctor, odio mauris
      23   tincidunt lorem diam a nisi. Duis vehicula ex ac tortor s│36   tincidunt lorem diam a nisi. Duis vehicula ex ac tortor s
      24   lectus venenatis. Nam efficitur justo eros, et ornare neq│37   lectus venenatis. Nam efficitur justo eros, et ornare neq
      25   vulputate nulla nunc, eget pellentesque diam aliquam at. │38   vulputate nulla nunc, eget pellentesque diam aliquam at.
      26   tortor posuere convallis sed sed risus. Quisque sed ipsum│39   tortor posuere convallis sed sed risus. Quisque sed ipsum
      27 <|                                                         │
      28 <|Cras non semper ante. Vivamus non nulla scelerisque, ferm│
      29 <|est. Sed convallis, magna sit amet maximus sollicitudin, │
      30 <|eros, eu molestie arcu urna ut nunc. Pellentesque habitan│
      31 <|senectus et netus et malesuada fames ac turpis egestas. M│
      32 <|turpis sit amet ultricies interdum, urna nisl rhoncus tel│
      33 <|urna risus ut arcu. Aliquam hendrerit eros id ex tempor v│
      34 <|risus. Nulla tincidunt, mauris eu pellentesque hendrerit,│
      35 <|sapien, vitae vehicula lacus tellus dictum augue. Pellent│
      36 <|tellus lobortis laoreet. Donec fringilla lacinia nulla si│
      37 <|Suspendisse iaculis metus sed massa bibendum, quis conseq│
      38 <|Etiam scelerisque odio nec pulvinar dapibus. Duis interdu│
      39 <|dapibus. Quisque dapibus nisl quis magna accumsan, et lob│
      40 <|Ut venenatis cursus diam, vel dictum augue interdum vitae│
      41 <|condimentum augue, eget bibendum augue lacinia in.       │
      42                                                            │40
      43   Aenean porta elit vitae pharetra dapibus. Duis a odio neq│41   Aenean porta elit vitae pharetra dapibus. Duis a odio neq
      44   ullamcorper enim ut metus luctus, eu blandit augue consec│42   ullamcorper enim ut metus luctus, eu blandit augue consec
      45   blandit lorem eget blandit fringilla. In et libero non la│43   blandit lorem eget blandit fringilla. In et libero non la
      46   id a orci. Maecenas porta urna mollis, egestas lacus id, │44   id a orci. Maecenas porta urna mollis, egestas lacus id,
      47   imperdiet ornare dui eleifend semper. Integer erat ipsum,│45   imperdiet ornare dui eleifend semper. Integer erat ipsum,
      48   eu, posuere in orci. Pellentesque gravida in purus eu ull│46   eu, posuere in orci. Pellentesque gravida in purus eu ull
      49   tortor, hendrerit nec eleifend et, dapibus sed dolor.    │47   tortor, hendrerit nec eleifend et, dapibus sed dolor."
    `);
  });

  it("test moves with nesting", () => {
    const prev = `
let foo = 3

let bar = 4

let rec test x =
  if x > 0
  then test (x-1)
  else x
;;

let message =
  "This is a message"
;;

let call_the_server () =
  Server.call {
      user;
      password;
      request
  }
;;

let read_the_file () =
  Reader.load_sexp "some-really-long file-path.sexp"
;;
`;
    const next = `
module Server = struct
  let call_the_server () =
    Server.call {
        user;
        password;
        request
    }
  ;;

  let read_the_file () =
    Reader.load_sexp
       "some-really-long file-path.sexp"
  ;;
end

let foo = 3

let bar = 4

let rec test x =
  if x > 0
  then test (x-1)
  else x
;;

let message =
  "This is a message"
;;

include Server
`;
    expect(formatTest({ prev, next, terminalWidth: 140, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      ---------------------------------------------------------------------│---------------------------------------------------------------------
         -|before                                                          │   +|after
                                                                           │ 1 +|
                                                                           │ 2 +|module Server = struct
                                                                           │ 3 >|  let call_the_server () =
                                                                           │ 4 >|    Server.call {
                                                                           │ 5 >|        user;
                                                                           │ 6 >|        password;
                                                                           │ 7 >|        request
                                                                           │ 8 >|    }
                                                                           │ 9 >|  ;;
                                                                           │10 >|
                                                                           │11 >|  let read_the_file () =
                                                                           │12 >|    Reader.load_sexp
                                                                           │13 >|       "some-really-long file-path.sexp"
                                                                           │14 >|  ;;
                                                                           │15 +|end
       1                                                                   │16
       2   let foo = 3                                                     │17   let foo = 3
       3                                                                   │18
       4   let bar = 4                                                     │19   let bar = 4
       5                                                                   │20
       6   let rec test x =                                                │21   let rec test x =
       7     if x > 0                                                      │22     if x > 0
       8     then test (x-1)                                               │23     then test (x-1)
       9     else x                                                        │24     else x
      10   ;;                                                              │25   ;;
      11                                                                   │26
      12   let message =                                                   │27   let message =
      13     "This is a message"                                           │28     "This is a message"
      14   ;;                                                              │29   ;;
      15                                                                   │30
      16 <|let call_the_server () =                                        │
      17 <|  Server.call {                                                 │
      18 <|      user;                                                     │
      19 <|      password;                                                 │
      20 <|      request                                                   │
      21 <|  }                                                             │
      22 <|;;                                                              │
      23 <|                                                                │
      24 <|let read_the_file () =                                          │
      25 <|  Reader.load_sexp "some-really-long file-path.sexp"            │
      26 <|;;                                                              │
                                                                           │31 +|include Server
      Truncated
      ---------------------------------------------------------------------│---------------------------------------------------------------------
         -|before                                                          │   +|after
                                                                           │ 1 +|
                                                                           │ 2 +|module Server = struct
                                                                           │ 3 >|  let call_the_server () =
                                                                           │ 4 >|    Server.call {
                                                                           │ 5 >|        user;
                                                                           │ 6 >|        password;
                                                                           │ 7 >|        request
                                                                           │ 8 >|    }
                                                                           │ 9 >|  ;;
                                                                           │10 >|
                                                                           │11 >|  let read_the_file () =
                                                                           │12 >|    Reader.load_sexp
                                                                           │13 >|       "some-really-long file-path.sexp"
                                                                           │14 >|  ;;
                                                                           │15 +|end
       1                                                                   │16
       2   let foo = 3                                                     │17   let foo = 3
       3                                                                   │18
       4   let bar = 4                                                     │19   let bar = 4
       5                                                                   │20
       6   let rec test x =                                                │21   let rec test x =
       7     if x > 0                                                      │22     if x > 0
       8     then test (x-1)                                               │23     then test (x-1)
       9     else x                                                        │24     else x
      10   ;;                                                              │25   ;;
      11                                                                   │26
      12   let message =                                                   │27   let message =
      13     "This is a message"                                           │28     "This is a message"
      14   ;;                                                              │29   ;;
      15                                                                   │30
      16 <|let call_the_server () =                                        │
      17 <|  Server.call {                                                 │
      18 <|      user;                                                     │
      19 <|      password;                                                 │
      20 <|      request                                                   │
      21 <|  }                                                             │
      22 <|;;                                                              │
      23 <|                                                                │
      24 <|let read_the_file () =                                          │
      25 <|  Reader.load_sexp "some-really-long file-path.sexp"            │
      26 <|;;                                                              │
                                                                           │31 +|include Server

      Wrapped
      ---------------------------------------------------------------------│---------------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                          │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                           │ 1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)(fg:default)
                                                                           │ 2 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)module Server = struct(fg:default)
                                                                           │ 3 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  let call_the_server () =(fg:default)
                                                                           │ 4 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Server.call {(fg:default)
                                                                           │ 5 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        user;(fg:default)
                                                                           │ 6 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        password;(fg:default)
                                                                           │ 7 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        request(fg:default)
                                                                           │ 8 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    }(fg:default)
                                                                           │ 9 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  ;;(fg:default)
                                                                           │10 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)(fg:default)
                                                                           │11 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  let read_the_file () =(fg:default)
                                                                           │12 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Reader.load_sexp(fg:default)(fg:green)(fg:default)
                                                                           │13 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:green)(fg:default)(fg:cyan)       "some-really-long file-path.sexp"(fg:default)
                                                                           │14 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  ;;(fg:default)
                                                                           │15 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)end(fg:default)
       1                                                                   │16
       2   let foo = 3                                                     │17   let foo = 3
       3                                                                   │18
       4   let bar = 4                                                     │19   let bar = 4
       5                                                                   │20
       6   let rec test x =                                                │21   let rec test x =
       7     if x > 0                                                      │22     if x > 0
       8     then test (x-1)                                               │23     then test (x-1)
       9     else x                                                        │24     else x
      10   ;;                                                              │25   ;;
      11                                                                   │26
      12   let message =                                                   │27   let message =
      13     "This is a message"                                           │28     "This is a message"
      14   ;;                                                              │29   ;;
      15                                                                   │30
      16 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let call_the_server () =(fg:default)                                        │
      17 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  Server.call {(fg:default)                                                 │
      18 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      user;(fg:default)                                                     │
      19 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      password;(fg:default)                                                 │
      20 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      request(fg:default)                                                   │
      21 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  }(fg:default)                                                             │
      22 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                              │
      23 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)(fg:default)                                                                │
      24 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let read_the_file () =(fg:default)                                          │
      25 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  Reader.load_sexp(fg:default)(fg:magenta) "some-really-long file-path.sexp"(fg:default)            │
      26 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                              │
                                                                           │31 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)include Server(fg:default)
      Truncated
      ---------------------------------------------------------------------│---------------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                          │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
                                                                           │ 1 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)(fg:default)
                                                                           │ 2 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)module Server = struct(fg:default)
                                                                           │ 3 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  let call_the_server () =(fg:default)
                                                                           │ 4 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Server.call {(fg:default)
                                                                           │ 5 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        user;(fg:default)
                                                                           │ 6 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        password;(fg:default)
                                                                           │ 7 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)        request(fg:default)
                                                                           │ 8 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    }(fg:default)
                                                                           │ 9 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  ;;(fg:default)
                                                                           │10 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)(fg:default)
                                                                           │11 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  let read_the_file () =(fg:default)
                                                                           │12 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Reader.load_sexp(fg:default)(fg:green)(fg:default)
                                                                           │13 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:green)(fg:default)(fg:cyan)       "some-really-long file-path.sexp"(fg:default)
                                                                           │14 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)  ;;(fg:default)
                                                                           │15 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)end(fg:default)
       1                                                                   │16
       2   let foo = 3                                                     │17   let foo = 3
       3                                                                   │18
       4   let bar = 4                                                     │19   let bar = 4
       5                                                                   │20
       6   let rec test x =                                                │21   let rec test x =
       7     if x > 0                                                      │22     if x > 0
       8     then test (x-1)                                               │23     then test (x-1)
       9     else x                                                        │24     else x
      10   ;;                                                              │25   ;;
      11                                                                   │26
      12   let message =                                                   │27   let message =
      13     "This is a message"                                           │28     "This is a message"
      14   ;;                                                              │29   ;;
      15                                                                   │30
      16 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let call_the_server () =(fg:default)                                        │
      17 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  Server.call {(fg:default)                                                 │
      18 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      user;(fg:default)                                                     │
      19 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      password;(fg:default)                                                 │
      20 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      request(fg:default)                                                   │
      21 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  }(fg:default)                                                             │
      22 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                              │
      23 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)(fg:default)                                                                │
      24 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let read_the_file () =(fg:default)                                          │
      25 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)  Reader.load_sexp(fg:default)(fg:magenta) "some-really-long file-path.sexp"(fg:default)            │
      26 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                              │
                                                                           │31 (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)(fg:green)include Server(fg:default)"
    `);
  });

  it("test side-by-side with move and leading whitespace", () => {
    const prev = `
open! Core
open! Async

let list =
    [ "This"
    ; "is"
    ; "a"
    ; "patdiff"
    ; "test"
    ]
;;

let prompt ~input =
    [%string
      \\{|
    Please enter the magic passphrase %{input}
    |\\}]
;;

let next i =
    i + 1
;;
`;
    const next = `
open! Core
open! Async

let prompt_renamed ~input =
    [%string
      \\{|
    Please enter the magic passphrase %{input}
    |\\}]
;;

let list =
    [ "This"
    ; "is"
    ; "a"
    ; "patdiff"
    ; "test"
    ]
;;

let next i =
    i + 1
;;
`;
    expect(formatTest({ prev, next, terminalWidth: 125, includeColors: true })).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   open! Core                                               │ 2   open! Core
       3   open! Async                                              │ 3   open! Async
                                                                    │ 4 >|
                                                                    │ 5 >|let prompt_renamed ~input =
                                                                    │ 6 >|    [%string
                                                                    │ 7 >|      \\{|
                                                                    │ 8 >|    Please enter the magic passphrase %{input}
                                                                    │ 9 >|    |\\}]
                                                                    │10 >|;;
       4                                                            │11
       5   let list =                                               │12   let list =
       6       [ "This"                                             │13       [ "This"
       7       ; "is"                                               │14       ; "is"
       8       ; "a"                                                │15       ; "a"
       9       ; "patdiff"                                          │16       ; "patdiff"
      10       ; "test"                                             │17       ; "test"
      11       ]                                                    │18       ]
      12   ;;                                                       │19   ;;
      13 <|                                                         │
      14 <|let prompt ~input =                                      │
      15 <|    [%string                                             │
      16 <|      \\{|                                                │
      17 <|    Please enter the magic passphrase %{input}           │
      18 <|    |\\}]                                                 │
      19 <|;;                                                       │
      20                                                            │20
      21   let next i =                                             │21   let next i =
      22       i + 1                                                │22       i + 1
      23   ;;                                                       │23   ;;
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
         -|before                                                   │   +|after
       1                                                            │ 1
       2   open! Core                                               │ 2   open! Core
       3   open! Async                                              │ 3   open! Async
                                                                    │ 4 >|
                                                                    │ 5 >|let prompt_renamed ~input =
                                                                    │ 6 >|    [%string
                                                                    │ 7 >|      \\{|
                                                                    │ 8 >|    Please enter the magic passphrase %{input}
                                                                    │ 9 >|    |\\}]
                                                                    │10 >|;;
       4                                                            │11
       5   let list =                                               │12   let list =
       6       [ "This"                                             │13       [ "This"
       7       ; "is"                                               │14       ; "is"
       8       ; "a"                                                │15       ; "a"
       9       ; "patdiff"                                          │16       ; "patdiff"
      10       ; "test"                                             │17       ; "test"
      11       ]                                                    │18       ]
      12   ;;                                                       │19   ;;
      13 <|                                                         │
      14 <|let prompt ~input =                                      │
      15 <|    [%string                                             │
      16 <|      \\{|                                                │
      17 <|    Please enter the magic passphrase %{input}           │
      18 <|    |\\}]                                                 │
      19 <|;;                                                       │
      20                                                            │20
      21   let next i =                                             │21   let next i =
      22       i + 1                                                │22       i + 1
      23   ;;                                                       │23   ;;

      Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                   │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
       1                                                            │ 1
       2   open! Core                                               │ 2   open! Core
       3   open! Async                                              │ 3   open! Async
                                                                    │ 4 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)(fg:default)
                                                                    │ 5 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)let prompt(fg:default)(fg:green)_renamed(fg:default)(fg:cyan) ~input =(fg:default)
                                                                    │ 6 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    [%string(fg:default)
                                                                    │ 7 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)      \\{|(fg:default)
                                                                    │ 8 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Please enter the magic passphrase %{input}(fg:default)
                                                                    │ 9 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    |\\}](fg:default)
                                                                    │10 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan);;(fg:default)
       4                                                            │11
       5   let list =                                               │12   let list =
       6       [ "This"                                             │13       [ "This"
       7       ; "is"                                               │14       ; "is"
       8       ; "a"                                                │15       ; "a"
       9       ; "patdiff"                                          │16       ; "patdiff"
      10       ; "test"                                             │17       ; "test"
      11       ]                                                    │18       ]
      12   ;;                                                       │19   ;;
      13 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)(fg:default)                                                         │
      14 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let prompt(fg:default)(fg:magenta) ~input =(fg:default)                                      │
      15 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    [%string(fg:default)                                             │
      16 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      \\{|(fg:default)                                                │
      17 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    Please enter the magic passphrase %{input}(fg:default)           │
      18 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    |\\}](fg:default)                                                 │
      19 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                       │
      20                                                            │20
      21   let next i =                                             │21   let next i =
      22       i + 1                                                │22       i + 1
      23   ;;                                                       │23   ;;
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
         (+bold fg:red)-|(-weight fg:default)(fg:red)(fg:default)before                                                   │   (+bold fg:green)+|(-weight fg:default)(fg:green)(fg:default)after
       1                                                            │ 1
       2   open! Core                                               │ 2   open! Core
       3   open! Async                                              │ 3   open! Async
                                                                    │ 4 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)(fg:default)
                                                                    │ 5 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)let prompt(fg:default)(fg:green)_renamed(fg:default)(fg:cyan) ~input =(fg:default)
                                                                    │ 6 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    [%string(fg:default)
                                                                    │ 7 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)      \\{|(fg:default)
                                                                    │ 8 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    Please enter the magic passphrase %{input}(fg:default)
                                                                    │ 9 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan)    |\\}](fg:default)
                                                                    │10 (+bold fg:cyan)>|(-weight fg:default)(fg:cyan)(fg:default)(fg:cyan);;(fg:default)
       4                                                            │11
       5   let list =                                               │12   let list =
       6       [ "This"                                             │13       [ "This"
       7       ; "is"                                               │14       ; "is"
       8       ; "a"                                                │15       ; "a"
       9       ; "patdiff"                                          │16       ; "patdiff"
      10       ; "test"                                             │17       ; "test"
      11       ]                                                    │18       ]
      12   ;;                                                       │19   ;;
      13 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)(fg:default)                                                         │
      14 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)let prompt(fg:default)(fg:magenta) ~input =(fg:default)                                      │
      15 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    [%string(fg:default)                                             │
      16 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)      \\{|(fg:default)                                                │
      17 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    Please enter the magic passphrase %{input}(fg:default)           │
      18 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta)    |\\}](fg:default)                                                 │
      19 (+bold fg:magenta)<|(-weight fg:default)(fg:magenta)(fg:default)(fg:magenta);;(fg:default)                                                       │
      20                                                            │20
      21   let next i =                                             │21   let next i =
      22       i + 1                                                │22       i + 1
      23   ;;                                                       │23   ;;"
    `);
  });

  it("Same ranges with whitespace-only differences render 'next' content on both sides (different number of lines)", () => {
    const prev = `let () =
  baz
    foo
      (* long comment that wraps here *)
      bar`;
    const next = `let () =
  foo
                (* long comment that
                    wraps here *)
    bar`;
    expect(
      formatTest({
        prev,
        next,
        terminalWidth: 125,
        markNewlineChanges: false,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|                (* long comment that                      │3 !|                (* long comment that
      5 !|                    wraps here *)                         │4 !|                    wraps here *)
      6         bar                                                 │5       bar
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|                (* long comment that                      │3 !|                (* long comment that
      5 !|                    wraps here *)                         │4 !|                    wraps here *)
      6         bar                                                 │5       bar"
    `);
    expect(
      formatTest({
        prev,
        next,
        terminalWidth: 125,
        markNewlineChanges: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps here *)                  │3 !|                (* long comment that
                                                                    │4 +|                    wraps here *)
      5         bar                                                 │5       bar
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps here *)                  │3 !|                (* long comment that
                                                                    │4 +|                    wraps here *)
      5         bar                                                 │5       bar"
    `);
  });

  it("Same ranges with whitespace-only differences render 'next' content on both sides (same number of lines)", () => {
    const prev = `let () =
  baz
    foo
      (* long comment that wraps
         here *)
      bar`;
    const next = `let () =
  foo
                (* long comment that
                    wraps here *)
    bar`;
    expect(
      formatTest({
        prev,
        next,
        terminalWidth: 125,
        markNewlineChanges: false,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps                          │3 !|                (* long comment that
      5 !|         here *)                                          │4 !|                    wraps here *)
      6         bar                                                 │5       bar
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps                          │3 !|                (* long comment that
      5 !|         here *)                                          │4 !|                    wraps here *)
      6         bar                                                 │5       bar"
    `);
    expect(
      formatTest({
        prev,
        next,
        terminalWidth: 125,
        markNewlineChanges: true,
      }),
    ).toMatchInlineSnapshot(`
      "Wrapped
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps                          │3 !|                (* long comment that
      5 !|         here *)                                          │4 !|                    wraps here *)
      6         bar                                                 │5       bar
      Truncated
      --------------------------------------------------------------│--------------------------------------------------------------
        -|before                                                    │  +|after
      1   let () =                                                  │1   let () =
      2 -|  baz                                                     │
      3       foo                                                   │2     foo
      4 !|      (* long comment that wraps                          │3 !|                (* long comment that
      5 !|         here *)                                          │4 !|                    wraps here *)
      6         bar                                                 │5       bar"
    `);
  });
});

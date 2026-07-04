/** Translation of OCaml [test_html_output.ml].
 *
 *  Acceptable drift from OCaml ground truth: the separator line between the hunk
 *  header and the first content line contains the two-space [line_same] prefix
 *  ("  "). The OCaml [%expect] block displays it as a blank line because
 *  ppx_expect's diff is whitespace-insensitive per line. Both implementations
 *  emit the literal "  " bytes; the snapshot here preserves them faithfully. */

import { describe, expect, it } from "vitest";
import type { DiffInput } from "./diff-input.js";
import { withoutUnix } from "./patdiff-core.js";

describe("test_html_output", () => {
  it("test outputting a move to HTML", () => {
    const prevText = `
Some code that is going to get moved somewhere. Make it long so
things are really similar. We only match on at least 3 lines
so make it 3 lines long.
a
b
c
d
e
f
this is deleted
`;
    const nextText = `
a
b
c
Some code that is going to get moved somewhere. Make it long so
things are really differs. We only match on at least 3 lines
so make it 3 lines long.
d
e
f
Some code that is going to get moved somewhere. Make it long so
things are really similar. We only match on at least 3 lines
so make it 3 lines long.
`;
    const prev: DiffInput = { name: "old", text: prevText };
    const next: DiffInput = { name: "new", text: nextText };
    const out = withoutUnix.patdiff({
      findMoves: true,
      prev,
      next,
      output: "Html",
      produceUnifiedLines: false,
    });
    expect(out).toMatchInlineSnapshot(`
      "<pre style="font-family:consolas,monospace">
      -1,11 +1,13
        
      <span style="color:#880088"><span style="font-weight:bold"><|</span></span><span style="color:#880088">Some code that is going to get moved somewhere. Make it long so</span>
      <span style="color:#880088"><span style="font-weight:bold"><|</span></span><span style="color:#880088">things are really similar. We only match on at least 3 lines</span>
      <span style="color:#880088"><span style="font-weight:bold"><|</span></span><span style="color:#880088">so make it 3 lines long.</span>
        a
        b
        c
      <span style="color:#008800"><span style="font-weight:bold">+|</span></span><span style="color:#008800">Some code that is going to get moved somewhere. Make it long so</span>
      <span style="color:#008800"><span style="font-weight:bold">+|</span></span><span style="color:#008800">things are really differs. We only match on at least 3 lines</span>
      <span style="color:#008800"><span style="font-weight:bold">+|</span></span><span style="color:#008800">so make it 3 lines long.</span>
        d
        e
        f
      <span style="color:#880000"><span style="font-weight:bold">-|</span></span><span style="color:#880000">this is deleted</span>
      <span style="color:#008888"><span style="font-weight:bold">>|</span></span><span style="color:#008888">Some code that is going to get moved somewhere. Make it long so</span>
      <span style="color:#008888"><span style="font-weight:bold">>|</span></span><span style="color:#008888">things are really similar. We only match on at least 3 lines</span>
      <span style="color:#008888"><span style="font-weight:bold">>|</span></span><span style="color:#008888">so make it 3 lines long.</span>
      </pre>"
    `);
  });
});

import { parseFilePath, parseRefName } from "cabaret-core";
import { type Doc, span } from "cabaret-views";
import { expect, test } from "vitest";
import { docHtml } from "../html.js";

test("renders styles as classes, links as indexed markers, and empty lines as empty divs", () => {
  const change = parseRefName("feature/x");
  const file = parseFilePath("src/a.ts");
  const doc: Doc = {
    lines: [
      { spans: [span("feature/x", { style: "heading", target: { kind: "change", change } })] },
      { spans: [] },
      { spans: [span("  "), span("src/a.ts", { target: { kind: "file", change, file } })] },
      { spans: [span("const x = 1;", { style: "added", target: { kind: "location", file, line: 1 }, tier: "jump" })] },
      { spans: [span("const x = 0;", { style: "removed" })] },
    ],
  };
  expect(docHtml(doc)).toMatchInlineSnapshot(`
    "<div class="line" data-line="0"><span class="heading target" data-span="0">feature/x</span></div>
    <div class="line" data-line="1"></div>
    <div class="line" data-line="2">  <span class="target" data-span="1">src/a.ts</span></div>
    <div class="line" data-line="3"><span class="added">const x = 1;</span></div>
    <div class="line" data-line="4"><span class="removed">const x = 0;</span></div>"
  `);
});

test("escapes markup in span text", () => {
  const doc: Doc = {
    lines: [
      { spans: [span('<script>alert("a & b")</script>')] },
      {
        spans: [
          span('a <b> & "c"', { style: "added", target: { kind: "location", file: parseFilePath("x"), line: 1 } }),
        ],
      },
    ],
  };
  expect(docHtml(doc)).toMatchInlineSnapshot(`
    "<div class="line" data-line="0">&lt;script&gt;alert(&quot;a &amp; b&quot;)&lt;/script&gt;</div>
    <div class="line" data-line="1"><span class="added target" data-span="0">a &lt;b&gt; &amp; &quot;c&quot;</span></div>"
  `);
});

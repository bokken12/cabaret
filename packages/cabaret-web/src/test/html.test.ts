import { parseBranchName, parseFilePath, userName } from "cabaret-core";
import { layout, section, span } from "cabaret-views";
import { expect, test } from "vitest";
import type { CodeHighlighter } from "../highlight.js";
import { foldAt, lineFiles, renderContent, visibleLines } from "../html.js";

const widgets = { kind: "change", change: parseBranchName("widgets") } as const;
const location = { kind: "location", change: widgets.change, file: parseFilePath("api.ts"), line: 3 } as const;

// Body lines carry their location anchor on the first span, as hunk body
// lines really do.
const diffish = layout([
  { spans: [span("api.ts", { style: "heading" })] },
  section({ spans: [span("-1,2 +1,2", { style: "hunk", target: location, tier: "jump" })] }, [
    {
      spans: [
        span("const a = 1;", { style: "removed", target: location, tier: "jump" }),
        span("", { style: "removed-word" }),
      ],
    },
    {
      spans: [
        span("const b = 2;", { style: "added", target: location, tier: "jump" }),
        span("!", { style: "added-word" }),
      ],
    },
    { spans: [span("const c = 3;", { style: "context", target: location, tier: "jump" })] },
  ]),
]);

test("renderContent washes lines, signs the gutter, and keeps jump targets plain", () => {
  expect(renderContent(diffish, new Set())).toMatchInlineSnapshot(`
    "<div class="line" data-line="0"><span class="gutter">   </span><span class="s-heading">api.ts</span></div>
    <div class="line w-hunk" data-line="1"><span class="fold-mark" title="toggle fold">▾</span><span class="gutter">   </span><span class="s-hunk">-1,2 +1,2</span></div>
    <div class="line w-removed" data-line="2"><span class="gutter">-  </span><span class="s-removed">const a = 1;</span><span class="s-removed-word"></span></div>
    <div class="line w-added" data-line="3"><span class="gutter">+  </span><span class="s-added">const b = 2;</span><span class="s-added-word">!</span></div>
    <div class="line" data-line="4"><span class="gutter">   </span><span class="s-context">const c = 3;</span></div>"
  `);
});

test("renderContent leaves the sign gutter off pages without washes", () => {
  const doc = layout([
    { spans: [span("gadgets", { style: "heading" })] },
    {
      spans: [span("ready to land", { style: "ready" }), span(" · "), span("blocked on review", { style: "blocked" })],
    },
  ]);
  expect(renderContent(doc, new Set())).toMatchInlineSnapshot(`
    "<div class="line" data-line="0"><span class="s-heading">gadgets</span></div>
    <div class="line" data-line="1"><span class="s-ready">ready to land</span> · <span class="s-blocked">blocked on review</span></div>"
  `);
});

test("renderContent renders links as anchors: pages by hash, URLs in a new tab, checkout targets as notes", () => {
  const doc = layout([
    {
      spans: [
        span("gadgets", { target: { kind: "change", change: parseBranchName("gadgets") } }),
        span(" "),
        span("test-org#7", { target: { kind: "url", url: "https://example.com/test-org/7" } }),
        span(" "),
        span("sync", { target: { kind: "action", change: parseBranchName("gadgets"), action: "sync" } }),
      ],
    },
  ]);
  expect(renderContent(doc, new Set())).toMatchInlineSnapshot(
    `"<div class="line" data-line="0"><a class="link" href="#/cabaret/show/gadgets">gadgets</a> <a class="link" href="https://example.com/test-org/7" target="_blank" rel="noreferrer">test-org#7</a> <a class="link" data-note="sync runs from a host with a checkout">sync</a></div>"`,
  );
});

test("renderContent escapes markup in text and carries a page's borrowed identity", () => {
  const doc = layout([
    {
      spans: [
        span('<b> & "quotes"', { style: "context" }),
        span("review", {
          target: { kind: "review", change: parseBranchName("gizmos"), as: userName("alice@example.com") },
        }),
      ],
    },
  ]);
  expect(renderContent(doc, new Set())).toMatchInlineSnapshot(
    `"<div class="line" data-line="0"><span class="s-context">&lt;b&gt; &amp; &quot;quotes&quot;</span><a class="link" href="#/as/alice%2540example.com/cabaret/review/gizmos">review</a></div>"`,
  );
});

test("a folded section renders as its heading wearing an ellipsis", () => {
  expect(renderContent(diffish, new Set([1]))).toMatchInlineSnapshot(`
    "<div class="line" data-line="0"><span class="gutter">   </span><span class="s-heading">api.ts</span></div>
    <div class="line w-hunk" data-line="1"><span class="fold-mark" title="toggle fold">▸</span><span class="gutter">   </span><span class="s-hunk">-1,2 +1,2</span><span class="dim"> …</span></div>"
  `);
});

test("lineFiles attributes fold bodies to the file their heading names, innermost fold winning", () => {
  const other = { kind: "location", change: widgets.change, file: parseFilePath("deep.py"), line: 1 } as const;
  const doc = layout([
    { spans: [span("title", { style: "heading" })] },
    section({ spans: [span("api.ts", { style: "heading", target: location, tier: "jump" })] }, [
      { spans: [span("outer body", { style: "context" })] },
      section({ spans: [span("deep.py", { target: other, tier: "jump" })] }, [
        { spans: [span("inner body", { style: "context" })] },
      ]),
    ]),
    { spans: [span("tail")] },
  ]);
  expect(lineFiles(doc)).toEqual(
    new Map([
      [2, "api.ts"],
      [3, "api.ts"],
      [4, "deep.py"],
    ]),
  );
});

test("renderContent colors code lines with the highlighter's tokens, split across word washes", () => {
  // Tokens split "const b = 2;!" as "const"/" b = 2;!": the color boundary
  // falls inside the added span, and the trailing token crosses into the
  // added-word span.
  const highlighter: CodeHighlighter = {
    tokens: (file, text) =>
      file === "api.ts"
        ? [
            { text: text.slice(0, 5), color: "#ff0000" },
            { text: text.slice(5), color: undefined },
          ]
        : undefined,
  };
  expect(renderContent(diffish, new Set(), highlighter)).toMatchInlineSnapshot(`
    "<div class="line" data-line="0"><span class="gutter">   </span><span class="s-heading">api.ts</span></div>
    <div class="line w-hunk" data-line="1"><span class="fold-mark" title="toggle fold">▾</span><span class="gutter">   </span><span class="s-hunk">-1,2 +1,2</span></div>
    <div class="line w-removed" data-line="2"><span class="gutter">-  </span><span class="s-removed"><span style="color:#ff0000">const</span> a = 1;</span><span class="s-removed-word"></span></div>
    <div class="line w-added" data-line="3"><span class="gutter">+  </span><span class="s-added"><span style="color:#ff0000">const</span> b = 2;</span><span class="s-added-word">!</span></div>
    <div class="line" data-line="4"><span class="gutter">   </span><span class="s-context"><span style="color:#ff0000">const</span> c = 3;</span></div>"
  `);
});

test("visibleLines hides a folded fold's body, including folds nested in it", () => {
  const doc = layout([
    { spans: [span("top")] },
    section({ spans: [span("outer")] }, [
      { spans: [span("body")] },
      section({ spans: [span("inner")] }, [{ spans: [span("deep")] }]),
    ]),
    { spans: [span("tail")] },
  ]);
  expect(visibleLines(doc, new Set())).toEqual([0, 1, 2, 3, 4, 5]);
  expect(visibleLines(doc, new Set([3]))).toEqual([0, 1, 2, 3, 5]);
  expect(visibleLines(doc, new Set([1]))).toEqual([0, 1, 5]);
  expect(visibleLines(doc, new Set([1, 3]))).toEqual([0, 1, 5]);
});

test("foldAt finds the innermost fold containing a line", () => {
  const doc = layout([
    section({ spans: [span("outer")] }, [
      { spans: [span("body")] },
      section({ spans: [span("inner")] }, [{ spans: [span("deep")] }]),
    ]),
    { spans: [span("tail")] },
  ]);
  expect(foldAt(doc, 0)).toEqual({ start: 0, end: 3 });
  expect(foldAt(doc, 3)).toEqual({ start: 2, end: 3 });
  expect(foldAt(doc, 4)).toBeUndefined();
});

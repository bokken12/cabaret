import { describe, expect, it } from "vitest";

import { String as PatienceString } from "./patience-diff.js";

function mergeAndPrint(arrs: ReadonlyArray<ReadonlyArray<string>>): string {
  const out: string[] = [];
  const merged = PatienceString.merge(arrs);
  for (const seg of merged) {
    if (seg.kind === "same") {
      out.push("---- Same -----");
      for (const line of seg.contents) {
        out.push("   " + line);
      }
    } else {
      out.push("-- Different --");
      seg.contents.forEach((arr, idx) => {
        for (const line of arr) {
          out.push("(" + idx + ")" + line);
        }
      });
    }
  }
  return out.join("\n") + "\n";
}

describe("merge", () => {
  it("Identical documents", () => {
    const doc = ["a", "b", "c", "d"];
    expect(mergeAndPrint([doc])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
         c
         d
      "
    `);
    expect(mergeAndPrint([doc, doc])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
         c
         d
      "
    `);
    expect(mergeAndPrint([doc, doc, doc])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
         c
         d
      "
    `);
  });

  it("Empty documents", () => {
    const doc = ["a", "b", "c"];
    expect(mergeAndPrint([doc, []])).toMatchInlineSnapshot(`
      "-- Different --
      (0)a
      (0)b
      (0)c
      "
    `);
    expect(mergeAndPrint([[], doc])).toMatchInlineSnapshot(`
      "-- Different --
      (1)a
      (1)b
      (1)c
      "
    `);
    expect(mergeAndPrint([doc, [""]])).toMatchInlineSnapshot(`
      "-- Different --
      (0)a
      (0)b
      (0)c
      (1)
      "
    `);
    expect(mergeAndPrint([[""], doc])).toMatchInlineSnapshot(`
      "-- Different --
      (0)
      (1)a
      (1)b
      (1)c
      "
    `);
  });

  it("Documents with trailing added lines", () => {
    const short = ["a", "b"];
    const long = ["a", "b", "c", "d"];
    expect(mergeAndPrint([short, long])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
      -- Different --
      (1)c
      (1)d
      "
    `);
    expect(mergeAndPrint([long, short])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
      -- Different --
      (0)c
      (0)d
      "
    `);
  });

  it("Documents with leading added lines", () => {
    const short = ["c", "d"];
    const long = ["a", "b", "c", "d"];
    expect(mergeAndPrint([short, long])).toMatchInlineSnapshot(`
      "-- Different --
      (1)a
      (1)b
      ---- Same -----
         c
         d
      "
    `);
    expect(mergeAndPrint([long, short])).toMatchInlineSnapshot(`
      "-- Different --
      (0)a
      (0)b
      ---- Same -----
         c
         d
      "
    `);
  });

  it("Mixed documents with changes", () => {
    const short = ["a", "b", "foo", "c", "d"];
    const long = ["a", "b", "c", "bar", "d"];
    expect(mergeAndPrint([short, long])).toMatchInlineSnapshot(`
      "---- Same -----
         a
         b
      -- Different --
      (0)foo
      ---- Same -----
         c
      -- Different --
      (1)bar
      ---- Same -----
         d
      "
    `);
  });
});

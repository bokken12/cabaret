import { describe, expect, it } from "vitest";
import { strip } from "../shared/string-util.js";
import type { DiffInput } from "./diff-input.js";
import { forDiff } from "./should-keep-whitespace.js";

const test = (file1: string, lines1: string, file2: string, lines2: string): string => {
  const prev: DiffInput = { name: file1, text: strip(lines1) };
  const next: DiffInput = { name: file2, text: strip(lines2) };
  const result = forDiff({ prev, next });
  const swapped = forDiff({ prev: next, next: prev });
  expect(swapped).toBe(result);
  return `(should_keep_whitespace ${result})`;
};

const test1 = (file1: string, contents1: string): string => test(file1, contents1, file1, contents1);

describe("ShouldKeepWhitespace.forDiff", () => {
  it(".txt vs .py", () => {
    expect(
      test(
        "not_python.txt",
        `not a python file`,
        "is_python.py",
        `
from __future__ import division
print 8/7
`,
      ),
    ).toMatchInlineSnapshot(`"(should_keep_whitespace true)"`);
  });

  it("#!/bin/python", () => {
    expect(
      test1(
        "python.py",
        `
#!/bin/python
print "foo"
`,
      ),
    ).toMatchInlineSnapshot(`"(should_keep_whitespace true)"`);
  });

  it("#!/usr/bin/env python3", () => {
    expect(
      test1(
        "python.py",
        `
#!/usr/bin/env python3
print "foo"
`,
      ),
    ).toMatchInlineSnapshot(`"(should_keep_whitespace true)"`);
  });

  it("#!/bin/bash", () => {
    expect(
      test1(
        "bash.sh",
        `
#!/bin/bash
echo foo
`,
      ),
    ).toMatchInlineSnapshot(`"(should_keep_whitespace false)"`);
  });

  it("f#", () => {
    expect(
      test1(
        "fsharp.fs",
        `
// Learn more about F# at http://fsharp.org

open System

[<EntryPoint>]
let main argv =
    printfn "Hello World from F#!"
    0 // return an integer exit code
`,
      ),
    ).toMatchInlineSnapshot(`"(should_keep_whitespace true)"`);
  });
});

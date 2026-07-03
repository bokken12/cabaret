import { describe, expect, it } from "vitest";
import { atom, list, printSexp } from "../shared/sexp.js";
import { linesOfContents } from "./file-helpers.js";

const formatResult = (contents: string): string => {
  const [lines, trailing] = linesOfContents(contents);
  const trailingAtom = trailing === "WithTrailingNewline" ? "With_trailing_newline" : "Missing_trailing_newline";
  return printSexp(list([list(lines.map(atom)), atom(trailingAtom)]));
};

describe("test_file_helpers", () => {
  it("lines_of_contents", () => {
    expect(formatResult("")).toMatchInlineSnapshot(`"(() With_trailing_newline)"`);
    expect(formatResult("hello")).toMatchInlineSnapshot(`"((hello) Missing_trailing_newline)"`);
    expect(formatResult("hello\nworld")).toMatchInlineSnapshot(`"((hello world) Missing_trailing_newline)"`);
    expect(formatResult("hello\nworld\n")).toMatchInlineSnapshot(`"((hello world) With_trailing_newline)"`);
  });
});

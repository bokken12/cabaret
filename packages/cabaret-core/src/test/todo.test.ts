import fc from "fast-check";
import { expect, test } from "vitest";
import { extractTodos, newTodos, type Todo } from "../index.js";

test("finds a TODO opening a line comment", () => {
  expect(extractTodos("const x = 1; // TODO: rename\n")).toMatchInlineSnapshot(`
    [
      {
        "col": 14,
        "content": "TODO: rename",
        "line": 1,
      },
    ]
  `);
});

test("each line-comment marker starts its own TODO", () => {
  const contents = ["// TODO: c-style", "# TODO: shell-style", "; TODO: lisp-style", "-- TODO: sql-style", ""].join(
    "\n",
  );
  expect(extractTodos(contents)).toMatchInlineSnapshot(`
    [
      {
        "col": 1,
        "content": "TODO: c-style",
        "line": 1,
      },
      {
        "col": 1,
        "content": "TODO: shell-style",
        "line": 2,
      },
      {
        "col": 1,
        "content": "TODO: lisp-style",
        "line": 3,
      },
      {
        "col": 1,
        "content": "TODO: sql-style",
        "line": 4,
      },
    ]
  `);
});

test("a line-comment TODO continues across consecutive comment lines", () => {
  const contents = ["let y = 2  # TODO: split this module", "           # into two", "let z = 3\n"].join("\n");
  expect(extractTodos(contents)).toMatchInlineSnapshot(`
    [
      {
        "col": 12,
        "content": "TODO: split this module
               # into two",
        "line": 1,
      },
    ]
  `);
});

test("a blank line ends a line-comment TODO", () => {
  expect(extractTodos("// TODO: one\n\n// unrelated\n")).toEqual([
    { line: 1, col: 1, content: "TODO: one" },
  ] satisfies Todo[]);
});

test("finds TODOs opening block comments, closing marker stripped", () => {
  const contents = ["/* TODO: c block */", "(* TODO: ml (* nested *) block *)", "<!-- TODO: xml block -->", ""].join(
    "\n",
  );
  expect(extractTodos(contents)).toMatchInlineSnapshot(`
    [
      {
        "col": 1,
        "content": "TODO: c block",
        "line": 1,
      },
      {
        "col": 1,
        "content": "TODO: ml (* nested *) block",
        "line": 2,
      },
      {
        "col": 1,
        "content": "TODO: xml block",
        "line": 3,
      },
    ]
  `);
});

test("a multi-line block comment carries its TODO's whole text", () => {
  expect(extractTodos("(* TODO: refactor\n   the parser *)\n")).toEqual([
    { line: 1, col: 1, content: "TODO: refactor\n   the parser" },
  ] satisfies Todo[]);
});

test("positions are 1-based and name the comment start, not the token", () => {
  expect(extractTodos("let a = 1\nlet b = 2  (* TODO: inline *)\n")).toEqual([
    { line: 2, col: 12, content: "TODO: inline" },
  ] satisfies Todo[]);
});

test("ignores a TODO that does not open a comment", () => {
  for (const contents of [
    'const s = "TODO: in a string";\n', // walk-back hits the quote
    "// fix this TODO later\n", // mid-comment, not opening it
    "TODO: at the very start of a file\n",
    "/* TODO: unterminated block\n",
    "a / TODO: one slash is not a line comment\n",
    "a - TODO: nor is one dash\n",
    "TODOS are not TODO_TOKENS or mastodons // TODOX\n",
  ]) {
    expect(extractTodos(contents)).toEqual([]);
  }
});

test("binary contents have no TODOs", () => {
  expect(extractTodos("// TODO: hidden\0by a NUL\n")).toEqual([]);
});

test("newTodos reports only the tip's unmatched TODOs", () => {
  const base = "// TODO: keep me\nconst x = 1;\n";
  const tip = "const y = 0;\n// TODO: keep me\nconst x = 1; // TODO: new one\n";
  expect(newTodos(base, tip)).toEqual([{ line: 3, col: 14, content: "TODO: new one" }] satisfies Todo[]);
});

test("a moved or reflowed TODO is not new", () => {
  const base = "# TODO: tidy this\n# up\nrest\n";
  // The same TODO shifted down and re-indented, with its whitespace redone.
  const movedTip = "prelude\nrest\n  # TODO:  tidy this\n  #  up\n";
  expect(newTodos(base, movedTip)).toEqual([]);
  // Block comments carry no per-line markers, so even re-wrapping the text
  // across different line breaks leaves the TODO matched.
  const blockBase = "(* TODO: tidy\n   this up *)\n";
  const blockTip = "filler\n(* TODO: tidy this\n   up *)\n";
  expect(newTodos(blockBase, blockTip)).toEqual([]);
});

test("a reworded TODO is new", () => {
  expect(newTodos("// TODO: fix\n", "// TODO: fix properly\n")).toEqual([
    { line: 1, col: 1, content: "TODO: fix properly" },
  ] satisfies Todo[]);
});

test("each base TODO matches at most one tip copy", () => {
  const base = "// TODO: dedupe\n";
  const tip = "// TODO: dedupe\na();\n// TODO: dedupe\n";
  expect(newTodos(base, tip)).toEqual([{ line: 3, col: 1, content: "TODO: dedupe" }] satisfies Todo[]);
});

test("an absent version has no TODOs", () => {
  expect(newTodos(undefined, "// TODO: brand new file\n")).toEqual([
    { line: 1, col: 1, content: "TODO: brand new file" },
  ] satisfies Todo[]);
  expect(newTodos("// TODO: deleted with its file\n", undefined)).toEqual([]);
});

test("a TODO opening a line comment anywhere in a file is extracted", () => {
  const text = () => fc.stringMatching(/^[ a-z.!?]{0,30}$/);
  fc.assert(
    fc.property(
      fc.array(text(), { maxLength: 8 }), // plain lines before
      fc.constantFrom("//", "#", ";", "--"),
      text().filter((s) => s.trim() !== ""),
      fc.array(text(), { maxLength: 8 }), // plain lines after
      (before, marker, message, after) => {
        const todoLine = `${marker} TODO ${message}`;
        // Plain lines never contain comment markers, so the only TODO is ours.
        const contents = `${[...before, todoLine, ...after].join("\n")}\n`;
        expect(extractTodos(contents)).toEqual([
          { line: before.length + 1, col: 1, content: `TODO ${message}`.trimEnd() },
        ] satisfies Todo[]);
      },
    ),
  );
});

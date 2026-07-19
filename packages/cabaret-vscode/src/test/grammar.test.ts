import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseBranchName, parseCommitHash, parseFilePath, type Revision } from "cabaret-core";
import { type DiffsPage, diffDoc, diffsDoc, docText, type EmbeddedLanguage, pageGrammar } from "cabaret-views";
import { beforeAll, expect, test } from "vitest";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, type IRawGrammar, Registry } from "vscode-textmate";

const alpha: EmbeddedLanguage = { id: "alpha", scope: "source.alpha", suffixes: [".alpha"], basenames: [] };
const beta: EmbeddedLanguage = { id: "beta", scope: "source.beta", suffixes: [], basenames: ["Betafile"] };

/** Toy grammars standing in for real languages: alpha has multi-line block
 *  comments, exactly the construct that bleeds across hunks. */
const embedded: Record<string, unknown> = {
  "source.alpha": {
    scopeName: "source.alpha",
    patterns: [
      { begin: "/\\*", end: "\\*/", name: "comment.block.alpha" },
      { match: "\\w+", name: "word.alpha" },
    ],
  },
  "source.beta": {
    scopeName: "source.beta",
    patterns: [{ match: "\\w+", name: "word.beta" }],
  },
};

let oniguruma: Promise<unknown> | undefined;

beforeAll(async () => {
  const wasm = readFileSync(createRequire(import.meta.url).resolve("vscode-oniguruma/release/onig.wasm"));
  oniguruma ??= loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  await oniguruma;
});

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => createOnigScanner(patterns),
    createOnigString: (text) => createOnigString(text),
  }),
  loadGrammar: (scope) =>
    Promise.resolve(
      (scope === "text.cabaret" ? pageGrammar([alpha, beta]) : (embedded[scope] ?? null)) as IRawGrammar | null,
    ),
});

interface Token {
  readonly text: string;
  readonly scopes: readonly string[];
}

async function tokenized(text: string): Promise<{ line: string; tokens: Token[] }[]> {
  const grammar = await registry.loadGrammar("text.cabaret");
  if (grammar === null) {
    throw new Error("text.cabaret did not load");
  }
  let state = INITIAL;
  return text.split("\n").map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return {
      line,
      tokens: result.tokens.map((token) => ({
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes,
      })),
    };
  });
}

function tokensOf(rows: readonly { line: string; tokens: Token[] }[], line: string | RegExp): Token[] {
  const row = rows.find((candidate) =>
    typeof line === "string" ? candidate.line === line : line.test(candidate.line),
  );
  if (row === undefined) {
    throw new Error(`no line matching ${String(line)}`);
  }
  return row.tokens;
}

function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

const widgets = parseBranchName("widgets");

/** Two hunks in one alpha file — the first opens a comment it never closes — then a beta file. */
const page: DiffsPage = {
  change: widgets,
  as: undefined,
  conflicts: [],
  round: {
    end: fake("3"),
    later: 0,
    files: [
      {
        file: parseFilePath("src/thing.alpha"),
        source: undefined,
        view: {
          kind: "two",
          prev: "alpha1\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nomega\n",
          next: "opened /*\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nclosed\n",
        },
      },
      { file: parseFilePath("sub/Betafile"), source: undefined, view: { kind: "two", prev: "x\n", next: "y\n" } },
    ],
  },
};

test("each hunk embeds its file's language, and a comment opened in one hunk stays there", async () => {
  const rows = await tokenized(docText(diffsDoc(page)));
  // Within the first hunk the opened comment runs on: that is the language's truth.
  expect(tokensOf(rows, "four")).toEqual([
    { text: "four", scopes: ["text.cabaret", "meta.embedded.block.alpha", "comment.block.alpha"] },
  ]);
  // The next hunk starts a fresh region, so the comment cannot bleed into it.
  expect(tokensOf(rows, "seven")).toEqual([
    { text: "seven", scopes: ["text.cabaret", "meta.embedded.block.alpha", "word.alpha"] },
  ]);
  // The next file's region embeds its own language.
  expect(tokensOf(rows, "y")).toEqual([
    { text: "y", scopes: ["text.cabaret", "meta.embedded.block.beta", "word.beta"] },
  ]);
  // Structural lines are chrome, not code: no embedded scope, no tokens of the language.
  expect(tokensOf(rows, "-7,4 +7,4")).toEqual([{ text: "-7,4 +7,4", scopes: ["text.cabaret"] }]);
  expect(tokensOf(rows, /^@+ src\/thing\.alpha @+$/).every(({ scopes }) => scopes.length === 1)).toBe(true);
});

test("a single-file diff page's title opens its file's section", async () => {
  const doc = diffDoc({
    change: widgets,
    file: parseFilePath("src/thing.alpha"),
    as: undefined,
    round: { end: fake("3"), later: 0, source: undefined, view: { kind: "two", prev: "x\n", next: "y\n" } },
  });
  const rows = await tokenized(docText(doc));
  expect(tokensOf(rows, "y")).toEqual([
    { text: "y", scopes: ["text.cabaret", "meta.embedded.block.alpha", "word.alpha"] },
  ]);
});

test("a 4-way page's hint sentence closes the open hunk region", async () => {
  const rows = await tokenized(
    ["@@@ x.alpha @@@", "-1,1 +1,1", "opened /*", "A change in the feature was reverted", "stranded"].join("\n"),
  );
  expect(tokensOf(rows, "A change in the feature was reverted").every(({ scopes }) => scopes.length === 1)).toBe(true);
  expect(tokensOf(rows, "stranded")).toEqual([{ text: "stranded", scopes: ["text.cabaret"] }]);
});

test("pageGrammar escapes file names into literal patterns", () => {
  const grammar = pageGrammar([{ id: "cpp", scope: "source.cpp", suffixes: [".c++"], basenames: ["c++.cfg"] }]);
  expect(grammar.repository["file-cpp"]?.begin).toBe(
    "^(?:@+ )?(?:\\S+ -> )?(?:\\S*\\.c\\+\\+|(?:\\S*/)?c\\+\\+\\.cfg)(?: \\(copied from \\S+\\))?(?: @+| in \\S.*)$",
  );
});

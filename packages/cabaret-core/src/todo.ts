/**
 * TODO comments, extracted the way Iron extracts CRs: a TODO token counts
 * only when it opens a comment, found by walking backwards from the token
 * over whitespace to a comment starter. This is what keeps a TODO inside a
 * string literal (or the middle of a sentence) from registering — the walk
 * hits a non-comment character and gives up.
 *
 * Supported comment syntaxes, per Iron: the //, #, ;, and -- line comments,
 * where the TODO's text continues across consecutive lines opening with the
 * same marker; and the C (non-nesting), ML (nesting), and XML block comments.
 */

/** A TODO comment. `content` runs from the TODO token to the end of its comment. */
export interface Todo {
  /** 1-based line of the comment's first character. */
  readonly line: number;
  /** 1-based column of the comment's first character. */
  readonly col: number;
  readonly content: string;
}

type LineKind = "c" | "sh" | "lisp" | "sql";

/**
 * A line comment's TODO ends before the first line that does not open with
 * its marker (a blank line qualifies). Each regex matches the newline
 * starting such a line.
 */
const LINE_ENDERS: Record<LineKind, RegExp> = {
  c: /\n[ \t]*\/?[^/ \t]/,
  sh: /\n[ \t]*[^# \t]/,
  lisp: /\n[ \t]*[^; \t]/,
  sql: /\n[ \t]*-?[^\- \t]/,
};

/** Index one past the content's last character for a line comment starting before `token`. */
function lineCommentEnd(contents: string, token: number, kind: LineKind): number {
  const match = LINE_ENDERS[kind].exec(contents.slice(token + 1));
  return match === null ? contents.length : token + 1 + match.index;
}

/** Index of the last character of the `*)` closing an ML comment open at `token`, honoring nesting. */
function mlCommentEnd(contents: string, token: number): number | undefined {
  const markers = /\(\*|\*\)/g;
  markers.lastIndex = token + 1;
  let depth = 0;
  for (let match = markers.exec(contents); match !== null; match = markers.exec(contents)) {
    if (match[0] === "(*") {
      depth++;
    } else if (depth === 0) {
      return match.index + 1;
    } else {
      depth--;
    }
  }
  return undefined;
}

/** Index of the last character of `ender`'s first occurrence after `token`. */
function nonNestingEnd(contents: string, token: number, ender: string): number | undefined {
  const at = contents.indexOf(ender, token + 1);
  return at === -1 ? undefined : at + ender.length - 1;
}

interface CommentBounds {
  /** Index of the comment's first character. */
  readonly start: number;
  /** The comment's text from the TODO token to its end, closing marker stripped. */
  readonly content: string;
}

type BlockKind = "c" | "ml" | "xml";

/** How each block comment closes, and the pattern stripped off the content's tail. */
const BLOCK_ENDS: Record<BlockKind, { end: (contents: string, token: number) => number | undefined; strip: RegExp }> = {
  c: { end: (contents, token) => nonNestingEnd(contents, token, "*/"), strip: /\*+\/$/ },
  ml: { end: mlCommentEnd, strip: /\*+\)$/ },
  xml: { end: (contents, token) => nonNestingEnd(contents, token, "-->"), strip: /-->$/ },
};

/**
 * The comment a TODO token at `token` opens, or undefined when the token is
 * not at the start of a comment (modulo whitespace) — walk backwards
 * classifying what immediately precedes it, as Iron does for CRs.
 */
function findCommentBounds(contents: string, token: number): CommentBounds | undefined {
  const lineComment = (kind: LineKind, start: number): CommentBounds => ({
    start,
    content: contents.slice(token, lineCommentEnd(contents, token, kind)),
  });
  const blockComment = (kind: BlockKind, start: number): CommentBounds | undefined => {
    const end = BLOCK_ENDS[kind].end(contents, token);
    if (end === undefined) {
      return undefined;
    }
    return { start, content: contents.slice(token, end + 1).replace(BLOCK_ENDS[kind].strip, "") };
  };
  type State =
    | { readonly kind: "plain" | "star" | "semi" | "hash" }
    | { readonly kind: "slashes" | "dashes"; readonly n: number };
  let state: State = { kind: "plain" };
  for (let pos = token - 1; ; pos--) {
    // The empty string stands for running off the start of the file: it
    // matches no marker, so every state resolves and the loop terminates.
    const c = pos >= 0 ? contents[pos] : "";
    switch (state.kind) {
      case "plain":
        switch (c) {
          case "/":
            state = { kind: "slashes", n: 1 };
            break;
          case "*":
            state = { kind: "star" };
            break;
          case ";":
            state = { kind: "semi" };
            break;
          case "#":
            state = { kind: "hash" };
            break;
          case "-":
            state = { kind: "dashes", n: 1 };
            break;
          case " ":
          case "\t":
          case "\n":
            break;
          default:
            return undefined;
        }
        break;
      case "star":
        switch (c) {
          case "*":
            break;
          case "/":
            return blockComment("c", pos);
          case "(":
            return blockComment("ml", pos);
          default:
            return undefined;
        }
        break;
      case "slashes":
        if (c === "/") {
          state = { kind: "slashes", n: state.n + 1 };
        } else {
          return state.n >= 2 ? lineComment("c", pos + 1) : undefined;
        }
        break;
      case "semi":
        if (c !== ";") {
          return lineComment("lisp", pos + 1);
        }
        break;
      case "hash":
        if (c !== "#") {
          return lineComment("sh", pos + 1);
        }
        break;
      case "dashes":
        if (c === "-") {
          state = { kind: "dashes", n: state.n + 1 };
        } else if (c === "!" && state.n >= 2 && pos > 0 && contents[pos - 1] === "<") {
          return blockComment("xml", pos - 1);
        } else {
          return state.n >= 2 ? lineComment("sql", pos + 1) : undefined;
        }
        break;
    }
  }
}

/** Extract the TODOs of one file version. Binary contents (any NUL byte) have none. */
export function extractTodos(contents: string): readonly Todo[] {
  if (contents.includes("\0")) {
    return [];
  }
  // Line starts, for translating a comment-start index into line and column.
  const lineStarts = [0];
  for (let i = contents.indexOf("\n"); i !== -1; i = contents.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }
  const todos: Todo[] = [];
  for (const match of contents.matchAll(/\bTODO\b/g)) {
    const bounds = findCommentBounds(contents, match.index);
    if (bounds === undefined) {
      continue;
    }
    let line = 0;
    let lineStart = 0;
    for (const start of lineStarts) {
      if (start > bounds.start) {
        break;
      }
      line++;
      lineStart = start;
    }
    todos.push({ line, col: bounds.start - lineStart + 1, content: bounds.content.trimEnd() });
  }
  return todos;
}

/** The comparison key under which a reworded TODO is new but a moved one is not. */
function condensed(todo: Todo): string {
  return todo.content.replace(/\s+/g, " ");
}

/**
 * The TODOs `tip` has beyond `base`: each tip TODO consumes at most one base
 * TODO with the same whitespace-condensed content, and the unconsumed remain.
 * Matching on content rather than position keeps a pre-existing TODO from
 * registering when edits merely move or reflow it. An undefined version (the
 * file absent on that side) has no TODOs.
 */
export function newTodos(base: string | undefined, tip: string | undefined): readonly Todo[] {
  const spare = new Map<string, number>();
  for (const todo of extractTodos(base ?? "")) {
    const key = condensed(todo);
    spare.set(key, (spare.get(key) ?? 0) + 1);
  }
  return extractTodos(tip ?? "").filter((todo) => {
    const key = condensed(todo);
    const n = spare.get(key) ?? 0;
    if (n === 0) {
      return true;
    }
    spare.set(key, n - 1);
    return false;
  });
}

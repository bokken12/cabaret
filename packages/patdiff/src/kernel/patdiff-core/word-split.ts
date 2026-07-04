/** Whitespace handling and word-tokenization helpers. */

import { isWhitespace, strip } from "../../shared/string-util.js";

/** Strip whitespace from a string and replace runs of whitespace with a single space.
 *  Mirrors OCaml's [remove_ws]: trims and collapses internal whitespace. */
export const removeWs = (s: string): string => {
  // Match OCaml: iterates over chars, tracking [in_ws] and [found_char].
  // Once we have a non-whitespace char after seeing whitespace, insert a single space.
  // We never emit leading whitespace (since [found_char] is initially false).
  const out: string[] = [];
  let inWs = false;
  let foundChar = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (isWhitespace(ch)) {
      inWs = true;
    } else {
      if (inWs && foundChar) {
        out.push(" ");
      }
      out.push(ch);
      inWs = false;
      foundChar = true;
    }
  }
  return out.join("");
};

/** Returns true if [s] is empty or contains only whitespace. */
export const isWs = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (!isWhitespace(s[i]!)) return false;
  }
  return true;
};

// Mirrors OCaml's [words_rex]: matches delimiters, punctuation runs, whitespace runs,
// or ANSI SGR sequences. The matched substrings are themselves emitted as tokens, so we
// use a regex that captures and split on it.
const DELIM_CHARS = `"{}[]#,.;()_`;
const PUNCT_CHARS = "=`+\\-/!@$%^&*:|<>";
// Escaped form suitable for character classes.
const escapeForCharClass = (s: string): string => s.replace(/[\\\]^-]/g, (m) => `\\${m}`);

const DELIM_RE = `[${escapeForCharClass(DELIM_CHARS)}]`;
const PUNCT_RE = `[${escapeForCharClass(PUNCT_CHARS)}]+`;
const SPACE_RE = `\\s+`;
const ANSI_SGR_RE = `\\x1b\\[[0-9;]*m`;
// We must use a global regex with capture group so that String.prototype.split keeps
// the delimiter pieces. We put the alternation in a single capture group.
const WORDS_REGEX = new RegExp(`(${ANSI_SGR_RE}|${PUNCT_RE}|${SPACE_RE}|${DELIM_RE})`, "g");

/** Replicates OCaml [Re.split_full] semantics: returns tokens, including delimiters
 *  and text segments, dropping empty results. If [keepWs] is false, right-strip [s]
 *  first. If [keepWs] and [s] is empty, return [""]. */
export const split = (s: string, keepWs: boolean): string[] => {
  let input = s;
  if (!keepWs) {
    // OCaml: String.rstrip - strip trailing whitespace.
    let end = input.length;
    while (end > 0 && isWhitespace(input[end - 1]!)) end--;
    input = input.slice(0, end);
  }
  if (input.length === 0 && keepWs) return [""];
  if (input.length === 0) return [];
  // String.split with a capturing regex keeps both delimiters and text pieces.
  const pieces = input.split(WORDS_REGEX);
  const out: string[] = [];
  for (const p of pieces) {
    if (p.length > 0) out.push(p);
  }
  return out;
};

/** Mirrors OCaml [whitespace_ignorant_split]: tokenizes without whitespace, but appends
 *  whitespace tokens to adjacent word tokens so patience diff doesn't count whitespace
 *  in the length of a match. */
export const whitespaceIgnorantSplit = (s: string): string[] => {
  if (s.length === 0) return [];
  // Split as usual (keepWs=false), then group consecutive tokens so each group ends at
  // a text-token boundary. OCaml uses [List.group ~break] which starts a new group
  // when [break] returns true; [break = fun split_result1 _ -> istext split_result1]
  // means: start a new group right after a text token.
  const tokens = split(s, false);
  const isText = (t: string): boolean => {
    // [istext s = not (Re.execp ws_rex s)] - true iff s has no whitespace at all.
    for (let i = 0; i < t.length; i++) {
      if (isWhitespace(t[i]!)) return false;
    }
    return true;
  };
  const groups: string[][] = [];
  let current: string[] = [];
  for (const t of tokens) {
    current.push(t);
    if (isText(t)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => g.join(""));
};

// Re-export strip for convenience.
export { strip };

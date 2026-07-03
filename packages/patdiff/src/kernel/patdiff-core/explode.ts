/** Word/newline tokenization for refined diffs. Mirrors OCaml's [explode]. */

import { isWs, split, whitespaceIgnorantSplit } from "./word-split.js";

/** A token produced by [explode]: either a run of consecutive newlines optionally
 *  followed by some subsequent whitespace, or a non-newline word. */
export type WordOrNewline =
  | { readonly kind: "newline"; readonly count: number; readonly trailer: string | undefined }
  | { readonly kind: "word"; readonly value: string };

const newline = (count: number, trailer: string | undefined): WordOrNewline => ({ kind: "newline", count, trailer });

const word = (value: string): WordOrNewline => ({ kind: "word", value });

/** Internal helper used by both [explode] and [refine]'s replace handling. Takes the
 *  pre-tokenized lines (one [string list] per source line) and recombines them with
 *  newlines following OCaml's [explode_internal]. */
export const explodeInternal = (wordsByLine: ReadonlyArray<readonly string[]>, keepWs: boolean): WordOrNewline[] => {
  // Step 1: prepend a Newline(1,...) to each line's tokens. If [keepWs] and the line
  // begins with a whitespace token, attach it as the newline's trailer and drop the
  // word. If empty line, only emit Newline(1, None).
  const tokens: WordOrNewline[] = [];
  for (const line of wordsByLine) {
    if (line.length === 0) {
      tokens.push(newline(1, undefined));
    } else {
      const hd = line[0]!;
      const tl = line.slice(1);
      if (keepWs && hd.length > 0 && isWs(hd)) {
        tokens.push(newline(1, hd));
        for (const t of tl) tokens.push(word(t));
      } else {
        tokens.push(newline(1, undefined));
        tokens.push(word(hd));
        for (const t of tl) tokens.push(word(t));
      }
    }
  }

  // Step 2: fold from the right to collapse adjacent newlines. We mirror OCaml's
  // [List.fold_right]: we iterate from the back and prepend each [x] to [acc], with
  // collapse logic where [x] is a newline and [hd acc] is a newline.
  let acc: WordOrNewline[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const x = tokens[i]!;
    if (acc.length === 0) {
      acc = [x];
      continue;
    }
    const head = acc[0]!;
    if (head.kind === "word") {
      acc = [x, ...acc];
      continue;
    }
    // head is newline
    if (head.trailer === undefined) {
      if (x.kind === "word") {
        // x : Word — keep order as [x; head; ...]
        acc = [x, ...acc];
      } else {
        // collapse: [head] becomes Newline(i+j, x.trailer)
        const collapsed = newline(x.count + head.count, x.trailer);
        acc = [collapsed, ...acc.slice(1)];
      }
    } else {
      // head.trailer is Some s1
      if (x.kind === "word") {
        acc = [x, ...acc];
      } else {
        // collapse: trailer = (x.trailer ?? "") ++ head.trailer
        const s1 = (x.trailer ?? "") + head.trailer;
        const collapsed = newline(x.count + head.count, s1);
        acc = [collapsed, ...acc.slice(1)];
      }
    }
  }

  // Step 3: drop one newline from the leading newline.
  if (acc.length > 0 && acc[0]!.kind === "newline") {
    const h = acc[0]!;
    acc = [newline(h.count - 1, h.trailer), ...acc.slice(1)];
  }

  // Step 4: append a Newline(1, None) at end if there are any words. (OCaml: don't drop
  // this section if it includes only a single newline.)
  if (acc.length > 0) {
    acc.push(newline(1, undefined));
  }
  return acc;
};

/** Public [explode]: takes an array of source lines and produces a flat array of word
 *  and newline tokens. */
export const explode = (lines: readonly string[], keepWs: boolean): WordOrNewline[] => {
  const wordsByLine = lines.map((s) => (keepWs ? split(s, true) : whitespaceIgnorantSplit(s)));
  return explodeInternal(wordsByLine, keepWs);
};

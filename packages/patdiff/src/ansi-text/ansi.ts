import * as Style from "./style.js";
import * as UnknownEsc from "./unknown-esc.js";

/** A parsed escape sequence. Only SGR styling is interpreted; every other
 *  sequence is preserved verbatim as [Unknown] so input round-trips exactly. */
export type T =
  | { readonly kind: "Style"; readonly style: Style.T }
  | { readonly kind: "Unknown"; readonly value: UnknownEsc.T };

export const Style_ = (style: Style.T): T => ({ kind: "Style", style });
export const UnknownOf = (value: UnknownEsc.T): T => ({ kind: "Unknown", value });

/** Colon-form color parameter: 38/48/58 with `5:n`, `2:r:g:b`, or `2:cs:r:g:b`
 *  (the colorspace id has no [Attr] representation and is dropped). Other colon
 *  forms (e.g. `4:3` curly underline) aren't representable either, and rewriting
 *  them with semicolons would change their meaning, so they stay Unknown. */
const colorForm = (subs: readonly number[]): readonly number[] | undefined => {
  const c0 = subs[0]!;
  if (c0 !== 38 && c0 !== 48 && c0 !== 58) return undefined;
  if (subs[1] === 5 && subs.length === 3) return subs;
  if (subs[1] === 2 && subs.length === 5) return subs;
  if (subs[1] === 2 && subs.length === 6) return [c0, 2, subs[3]!, subs[4]!, subs[5]!];
  return undefined;
};

/** SGR parameters: `;`-separated, each either a code or a `:`-joined subparam
 *  group. An empty parameter defaults to 0 (Reset) per ECMA-48. Returns
 *  undefined when the list isn't SGR we can represent — the sequence then
 *  round-trips as Unknown rather than misparsing (e.g. as a spurious Reset). */
const parseParams = (params: string): readonly (readonly number[])[] | undefined => {
  const pieces: (readonly number[])[] = [];
  for (const piece of params.split(";")) {
    if (piece.length === 0) {
      pieces.push([0]);
      continue;
    }
    const subs: number[] = [];
    for (const sub of piece.split(":")) {
      if (sub.length === 0) continue; // omitted subparam, e.g. colorspace in 38:2::r:g:b
      if (!/^\d+$/.test(sub)) return undefined;
      subs.push(Number(sub));
    }
    if (subs.length === 0) return undefined;
    if (piece.includes(":")) {
      const color = colorForm(subs);
      if (color === undefined) return undefined;
      pieces.push(color);
    } else {
      pieces.push(subs);
    }
  }
  return pieces;
};

export const ofCsi = (paramString: string, intermediate: string, terminal: string, privatePrefix?: string): T => {
  // Intermediate bytes mean the sequence is not SGR, whatever its final byte.
  if (privatePrefix === undefined && intermediate.length === 0 && terminal === "m") {
    const pieces = parseParams(paramString);
    if (pieces !== undefined) return Style_(Style.ofSgrParams(pieces));
  }
  return UnknownOf(UnknownEsc.ofCsi(paramString + intermediate, terminal, privatePrefix));
};

export const toString = (t: T): string => {
  switch (t.kind) {
    case "Style":
      return Style.toString(t.style);
    case "Unknown":
      return UnknownEsc.toString(t.value);
  }
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Style":
      return Style.toStringHum(t.style);
    case "Unknown":
      return UnknownEsc.toStringHum(t.value);
  }
};

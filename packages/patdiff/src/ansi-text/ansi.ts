import * as Style from "./style.js";
import * as UnknownEsc from "./unknown-esc.js";

/** A parsed escape sequence. Only SGR styling is interpreted; every other
 *  sequence is preserved verbatim as [Unknown] so input round-trips exactly. */
export type T =
  | { readonly kind: "Style"; readonly style: Style.T }
  | { readonly kind: "Unknown"; readonly value: UnknownEsc.T };

export const Style_ = (style: Style.T): T => ({ kind: "Style", style });
export const UnknownOf = (value: UnknownEsc.T): T => ({ kind: "Unknown", value });

const parseParams = (params: string): readonly (number | undefined)[] => {
  if (params.length === 0) return [];
  return params.split(";").map((s) => {
    if (s.length === 0) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n)) return undefined;
    return n;
  });
};

export const ofCsi = (paramString: string, terminal: string, privatePrefix?: string): T => {
  if (privatePrefix === undefined && terminal === "m") {
    return Style_(Style.ofSgrParams(parseParams(paramString)));
  }
  return UnknownOf(UnknownEsc.ofCsi(paramString, terminal, privatePrefix));
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

import * as Ansi from "./ansi.js";
import * as Text from "./text.js";
import type { Element, T as TextWithAnsi } from "./text-with-ansi-types.js";
import * as UnknownEsc from "./unknown-esc.js";

const ESC = "\x1b";
const BEL = "\x07";

const isCsiParamByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x30 <= code && code <= 0x3f;
};
const isCsiIntermediateByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x20 <= code && code <= 0x2f;
};
const isCsiFinalByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x40 <= code && code <= 0x7e;
};
const isFeByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x40 <= code && code <= 0x5f;
};
const isFpByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x60 <= code && code <= 0x7e;
};
const isNfFinalByte = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return 0x30 <= code && code <= 0x7e;
};

const textOfTrailing = (s: string): Element[] => {
  if (s.length === 0) return [];
  return [{ kind: "Text", text: Text.ofString(s) }];
};

class Cursor {
  pos = 0;
  constructor(public readonly src: string) {}
  peek(): string | undefined {
    if (this.pos >= this.src.length) return undefined;
    return this.src[this.pos];
  }
  advance(n = 1): void {
    this.pos += n;
  }
  available(): number {
    return this.src.length - this.pos;
  }
  peekString(n: number): string | undefined {
    if (this.available() < n) return undefined;
    return this.src.slice(this.pos, this.pos + n);
  }
  takeWhile(pred: (c: string) => boolean): string {
    const start = this.pos;
    while (this.pos < this.src.length && pred(this.src[this.pos]!)) {
      this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }
}

const parseCsi = (cur: Cursor): Element[] => {
  // Already consumed '[' before entry
  let privatePrefix: string | undefined;
  if (cur.peek() === "?") {
    cur.advance(1);
    privatePrefix = "?";
  }
  const params = cur.takeWhile(isCsiParamByte);
  const intermediate = cur.takeWhile(isCsiIntermediateByte);
  const next = cur.peek();
  if (next !== undefined && isCsiFinalByte(next)) {
    cur.advance(1);
    return [Ansi.ofCsi(params, next, privatePrefix)];
  }
  const paramsCombined = privatePrefix !== undefined ? `${privatePrefix}${params}` : params;
  return [{ kind: "Unknown", value: UnknownEsc.Fe("[") }, ...textOfTrailing(paramsCombined + intermediate)];
};

const isOscTerminator = (c: string): boolean => c === ESC || c === BEL;

const parseOsc = (cur: Cursor): Element[] => {
  // Already consumed ']' before entry
  const payload = cur.takeWhile((c) => !isOscTerminator(c));
  const next = cur.peek();
  if (next === BEL) {
    cur.advance(1);
    return [{ kind: "Unknown", value: UnknownEsc.Osc(payload, "Bel") }];
  }
  if (next !== undefined && cur.available() >= 2 && cur.peekString(2) === "\x1b\\") {
    cur.advance(2);
    return [{ kind: "Unknown", value: UnknownEsc.Osc(payload, "St") }];
  }
  return [{ kind: "Unknown", value: UnknownEsc.Fe("]") }, ...textOfTrailing(payload)];
};

const parseOtherEscape = (cur: Cursor): Element[] => {
  const next = cur.peek();
  if (next === undefined || next === ESC) {
    return [{ kind: "Unknown", value: UnknownEsc.Incomplete }];
  }
  const escaped = next;
  if (isFeByte(escaped)) {
    cur.advance(1);
    return [{ kind: "Unknown", value: UnknownEsc.Fe(escaped) }];
  }
  if (isFpByte(escaped)) {
    cur.advance(1);
    return [{ kind: "Unknown", value: UnknownEsc.Fp(escaped) }];
  }
  if (isCsiIntermediateByte(escaped)) {
    const intermediates = cur.takeWhile(isCsiIntermediateByte);
    const final = cur.peek();
    if (final !== undefined && isNfFinalByte(final)) {
      cur.advance(1);
      return [{ kind: "Unknown", value: UnknownEsc.Nf(intermediates + final) }];
    }
    return [{ kind: "Unknown", value: UnknownEsc.Incomplete }, ...textOfTrailing(intermediates)];
  }
  return [{ kind: "Unknown", value: UnknownEsc.Incomplete }];
};

const parseEscapeSequence = (cur: Cursor): Element[] => {
  // Already consumed ESC before entry
  const next = cur.peek();
  if (next === undefined) {
    return [{ kind: "Unknown", value: UnknownEsc.Incomplete }];
  }
  if (next === "[") {
    cur.advance(1);
    return parseCsi(cur);
  }
  if (next === "]") {
    cur.advance(1);
    return parseOsc(cur);
  }
  return parseOtherEscape(cur);
};

const parsePlainText = (cur: Cursor): Element[] => {
  const start = cur.pos;
  while (cur.pos < cur.src.length && cur.src[cur.pos] !== ESC) {
    cur.pos += 1;
  }
  const s = cur.src.slice(start, cur.pos);
  return [{ kind: "Text", text: Text.ofString(s) }];
};

export const parse = (s: string): TextWithAnsi => {
  const cur = new Cursor(s);
  const result: Element[] = [];
  while (cur.peek() !== undefined) {
    let elements: Element[];
    if (cur.peek() === ESC) {
      cur.advance(1);
      elements = parseEscapeSequence(cur);
    } else {
      elements = parsePlainText(cur);
    }
    for (const e of elements) result.push(e);
  }
  return result;
};

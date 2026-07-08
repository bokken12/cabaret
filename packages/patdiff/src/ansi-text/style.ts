import * as Attr from "./attr.js";

export type T = readonly Attr.T[];

export const equalLiteral = (a: T, b: T): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Attr.equal(a[i]!, b[i]!)) return false;
  }
  return true;
};

/** Each param is a subparam group: singletons for `;`-separated codes, longer
 *  groups for colon-form colors (already validated by the parser). */
export const ofSgrParams = (params: readonly (readonly number[])[]): T => {
  const single = (i: number): number | undefined => {
    const p = params[i];
    return p !== undefined && p.length === 1 ? p[0] : undefined;
  };
  const acc: Attr.T[] = [];
  let i = 0;
  while (i < params.length) {
    const piece = params[i]!;
    if (piece.length > 1) {
      acc.push(Attr.ofCodes(piece));
      i += 1;
      continue;
    }
    const c0 = piece[0]!;
    const isColorIntro = c0 === 38 || c0 === 48 || c0 === 58;
    if (
      isColorIntro &&
      single(i + 1) === 2 &&
      single(i + 2) !== undefined &&
      single(i + 3) !== undefined &&
      single(i + 4) !== undefined
    ) {
      acc.push(Attr.ofCodes([c0, 2, single(i + 2)!, single(i + 3)!, single(i + 4)!]));
      i += 5;
    } else if (isColorIntro && single(i + 1) === 5 && single(i + 2) !== undefined) {
      acc.push(Attr.ofCodes([c0, 5, single(i + 2)!]));
      i += 3;
    } else {
      acc.push(Attr.ofCodes([c0]));
      i += 1;
    }
  }
  return acc;
};

export const toString = (t: T): string => {
  if (t.length === 0) return "";
  const escCodes = t.map(Attr.toString).join(";");
  return `\x1b[${escCodes}m`;
};

export const includesReset = (t: T): boolean => t.some((a) => a.kind === "Reset");

export const isReset = (t: T): boolean => {
  if (t.length === 0) return false;
  return t[t.length - 1]!.kind === "Reset";
};

const afterReset = (t: T): readonly Attr.T[] => {
  let acc: readonly Attr.T[] = t;
  let remaining: readonly Attr.T[] = t;
  while (remaining.length > 0) {
    const hd = remaining[0]!;
    const tl = remaining.slice(1);
    if (hd.kind === "Reset") {
      acc = tl;
    }
    remaining = tl;
  }
  return acc;
};

export const compress = (t: T): T => {
  const reversed = [...t].reverse();
  const acc: Attr.T[] = [];
  let remaining: Attr.T[] = reversed;
  while (remaining.length > 0) {
    const attr = remaining[0]!;
    const rest = remaining.slice(1);
    remaining = rest.filter((a) => !Attr.overrides(attr, a));
    acc.unshift(attr);
  }
  return acc;
};

export const equal = (s1: T, s2: T): boolean => {
  if (equalLiteral(s1, s2)) return true;
  return equalLiteral(compress(s1), compress(s2));
};

export const update = (oldStyle: T, addedStyle: T): T => compress([...oldStyle, ...addedStyle]);

export const delta = (oldStyle: T, addedStyle: T): T => {
  const old = compress(oldStyle);
  const added = compress(addedStyle);
  const oldReset = includesReset(old);
  const newReset = includesReset(added);
  if (oldReset && newReset) {
    const oldAttrs = afterReset(old);
    const newAttrs = afterReset(added);
    const toDrop = oldAttrs.filter((oldAttr) => !newAttrs.some((newAttr) => Attr.overrides(newAttr, oldAttr)));
    const toAdd = newAttrs.filter((newAttr) => !oldAttrs.some((oldAttr) => Attr.equal(newAttr, oldAttr)));
    const withoutReset: Attr.T[] = [];
    for (const a of toDrop) {
      const off = Attr.turnOff(a);
      if (off !== undefined) withoutReset.push(off);
    }
    withoutReset.push(...toAdd);
    if (withoutReset.length < added.length) return withoutReset;
    return added;
  }
  if (!oldReset && newReset) {
    return [Attr.Reset, ...afterReset(added)];
  }
  return added.filter((newAttr) => {
    let lastOverridden: Attr.T | undefined;
    for (const oldAttr of old) {
      if (Attr.overrides(newAttr, oldAttr)) lastOverridden = oldAttr;
    }
    if (lastOverridden !== undefined && Attr.equal(lastOverridden, newAttr)) {
      return false;
    }
    return true;
  });
};

export const turnOff = (t: T): T => {
  const offs: Attr.T[] = [];
  for (const a of t) {
    const off = Attr.turnOff(a);
    if (off !== undefined) offs.push(off);
  }
  return compress(offs);
};

export const closes = (newStyle: T, oldStyle: T): boolean =>
  oldStyle.every((oldAttr) => newStyle.some((newAttr) => Attr.overrides(newAttr, oldAttr)));

export const toStringHum = (t: T): string => {
  if (t.length === 0) return "";
  const inner = t.map(Attr.toStringHum).join(" ");
  return `(${inner})`;
};

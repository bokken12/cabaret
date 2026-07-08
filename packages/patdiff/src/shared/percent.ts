declare const PercentBrand: unique symbol;
export type Percent = number & { readonly [PercentBrand]: true };

const make = (n: number): Percent => n as Percent;

export const ofPercentage = (n: number): Percent => make(n / 100);
export const ofMult = (n: number): Percent => make(n);
export const ofBp = (n: number): Percent => make(n / 10000);

export const toMult = (p: Percent): number => p as number;
export const toPercentage = (p: Percent): number => (p as number) * 100;
export const toBp = (p: Percent): number => (p as number) * 10000;

/**
 * Mirrors sexplib's `Percent.t` printing: chooses the unit that yields the
 * "nicest" representation. Order of preference: bp if value <1%, % if <100x,
 * otherwise x.
 */
export const toString = (p: Percent): string => {
  const m = p as number;
  if (m === 0) return "0x";
  const abs = Math.abs(m);
  if (abs < 0.01) return `${m * 10000}bp`;
  if (abs < 1) return `${m * 100}%`;
  return `${m}x`;
};

export const parse = (s: string): Percent => {
  const t = s.trim();
  // [Number("")] is 0, so a bare suffix must be rejected explicitly.
  const numberOf = (numeric: string): number => {
    const n = numeric.trim() === "" ? NaN : Number(numeric);
    if (!Number.isFinite(n)) throw new Error(`Invalid percent: ${s}`);
    return n;
  };
  if (t.endsWith("bp")) return ofBp(numberOf(t.slice(0, -2)));
  if (t.endsWith("x")) return ofMult(numberOf(t.slice(0, -1)));
  if (t.endsWith("%")) return ofPercentage(numberOf(t.slice(0, -1)));
  throw new Error(`Invalid percent (no unit suffix): ${s}`);
};

export const Percent = {
  ofPercentage,
  ofMult,
  ofBp,
  toMult,
  toPercentage,
  toBp,
  toString,
  parse,
} as const;

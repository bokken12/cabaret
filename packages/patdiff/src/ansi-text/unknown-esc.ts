export type T =
  | { readonly kind: "Csi"; readonly value: string }
  | { readonly kind: "Fe"; readonly value: string }
  | { readonly kind: "Fp"; readonly value: string }
  | { readonly kind: "Nf"; readonly value: string }
  | { readonly kind: "Incomplete" };

export const Csi = (value: string): T => ({ kind: "Csi", value });
export const Fe = (value: string): T => ({ kind: "Fe", value });
export const Fp = (value: string): T => ({ kind: "Fp", value });
export const Nf = (value: string): T => ({ kind: "Nf", value });
export const Incomplete: T = { kind: "Incomplete" };

export const ofCsi = (params: string, terminal: string, privatePrefix?: string): T => {
  if (privatePrefix === undefined) {
    return Csi(`${params}${terminal}`);
  }
  return Csi(`${privatePrefix}${params}${terminal}`);
};

export const toString = (t: T): string => {
  switch (t.kind) {
    case "Csi":
      return `\x1b[${t.value}`;
    case "Fe":
      return `\x1b${t.value}`;
    case "Fp":
      return `\x1b${t.value}`;
    case "Nf":
      return `\x1b${t.value}`;
    case "Incomplete":
      return "\x1b";
  }
};

const charEscaped = (c: string): string => {
  // Mimics OCaml's Char.escaped: printable ASCII becomes itself; otherwise \nnn etc.
  const code = c.charCodeAt(0);
  if (code === 0x27) return "\\'";
  if (code === 0x22) return '\\"';
  if (code === 0x5c) return "\\\\";
  if (code === 0x0a) return "\\n";
  if (code === 0x09) return "\\t";
  if (code === 0x0d) return "\\r";
  if (code === 0x08) return "\\b";
  if (code >= 0x20 && code <= 0x7e) return c;
  return `\\${code.toString().padStart(3, "0")}`;
};

const stringEscaped = (s: string): string => {
  let result = "";
  for (const c of s) {
    result += charEscaped(c);
  }
  return result;
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Csi":
      return `(ANSI-CSI:${t.value})`;
    case "Fe":
      return `(ANSI-Fe:${charEscaped(t.value)})`;
    case "Fp":
      return `(ANSI-Fp:${charEscaped(t.value)})`;
    case "Nf":
      return `(ANSI-nF:${stringEscaped(t.value)})`;
    case "Incomplete":
      return "(ESC)";
  }
};

export const equal = (a: T, b: T): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "Incomplete" || b.kind === "Incomplete") return a.kind === b.kind;
  return (a as Exclude<T, { kind: "Incomplete" }>).value === (b as Exclude<T, { kind: "Incomplete" }>).value;
};

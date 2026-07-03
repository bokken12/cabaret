import * as Color from "./color.js";

export type T =
  | { readonly kind: "Reset" }
  | { readonly kind: "Bold" }
  | { readonly kind: "Faint" }
  | { readonly kind: "Normal_weight" }
  | { readonly kind: "Italic" }
  | { readonly kind: "Fraktur" }
  | { readonly kind: "Not_emphasis" }
  | { readonly kind: "Underline" }
  | { readonly kind: "Double_ul" }
  | { readonly kind: "Not_underline" }
  | { readonly kind: "Blink" }
  | { readonly kind: "Fast_blink" }
  | { readonly kind: "Not_blink" }
  | { readonly kind: "Framed" }
  | { readonly kind: "Encircled" }
  | { readonly kind: "Not_framed" }
  | { readonly kind: "Superscript" }
  | { readonly kind: "Subscript" }
  | { readonly kind: "Not_script" }
  | { readonly kind: "Invert" }
  | { readonly kind: "Not_invert" }
  | { readonly kind: "Hide" }
  | { readonly kind: "Not_hide" }
  | { readonly kind: "Strike" }
  | { readonly kind: "Not_strike" }
  | { readonly kind: "Overline" }
  | { readonly kind: "Not_overline" }
  | { readonly kind: "Variable_width" }
  | { readonly kind: "Fixed_width" }
  | { readonly kind: "Fg"; readonly color: Color.T }
  | { readonly kind: "Bg"; readonly color: Color.T }
  | { readonly kind: "Ul_color"; readonly color: Color.T }
  | { readonly kind: "Font"; readonly value: number }
  | { readonly kind: "Ideogram"; readonly value: number }
  | { readonly kind: "Other"; readonly codes: readonly number[] };

export const Reset: T = { kind: "Reset" };
export const Bold: T = { kind: "Bold" };
export const Faint: T = { kind: "Faint" };
export const NormalWeight: T = { kind: "Normal_weight" };
export const Italic: T = { kind: "Italic" };
export const Fraktur: T = { kind: "Fraktur" };
export const NotEmphasis: T = { kind: "Not_emphasis" };
export const Underline: T = { kind: "Underline" };
export const DoubleUl: T = { kind: "Double_ul" };
export const NotUnderline: T = { kind: "Not_underline" };
export const Blink: T = { kind: "Blink" };
export const FastBlink: T = { kind: "Fast_blink" };
export const NotBlink: T = { kind: "Not_blink" };
export const Framed: T = { kind: "Framed" };
export const Encircled: T = { kind: "Encircled" };
export const NotFramed: T = { kind: "Not_framed" };
export const Superscript: T = { kind: "Superscript" };
export const Subscript: T = { kind: "Subscript" };
export const NotScript: T = { kind: "Not_script" };
export const Invert: T = { kind: "Invert" };
export const NotInvert: T = { kind: "Not_invert" };
export const Hide: T = { kind: "Hide" };
export const NotHide: T = { kind: "Not_hide" };
export const Strike: T = { kind: "Strike" };
export const NotStrike: T = { kind: "Not_strike" };
export const Overline: T = { kind: "Overline" };
export const NotOverline: T = { kind: "Not_overline" };
export const VariableWidth: T = { kind: "Variable_width" };
export const FixedWidth: T = { kind: "Fixed_width" };
export const Fg = (color: Color.T): T => ({ kind: "Fg", color });
export const Bg = (color: Color.T): T => ({ kind: "Bg", color });
export const UlColor = (color: Color.T): T => ({ kind: "Ul_color", color });
export const Font = (value: number): T => ({ kind: "Font", value });
export const Ideogram = (value: number): T => ({ kind: "Ideogram", value });
export const Other = (codes: readonly number[]): T => ({ kind: "Other", codes });

export const equal = (a: T, b: T): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Fg":
    case "Bg":
    case "Ul_color":
      return Color.equal(a.color, (b as typeof a).color);
    case "Font":
    case "Ideogram":
      return a.value === (b as typeof a).value;
    case "Other": {
      const bb = b as typeof a;
      if (a.codes.length !== bb.codes.length) return false;
      for (let i = 0; i < a.codes.length; i++) {
        if (a.codes[i] !== bb.codes[i]) return false;
      }
      return true;
    }
    default:
      return true;
  }
};

export const turnOff = (t: T): T | undefined => {
  switch (t.kind) {
    case "Reset":
      return undefined;
    case "Fg":
      if (t.color.kind === "Default") return undefined;
      return Fg(Color.Default);
    case "Bg":
      if (t.color.kind === "Default") return undefined;
      return Bg(Color.Default);
    case "Ul_color":
      if (t.color.kind === "Default") return undefined;
      return UlColor(Color.Default);
    case "Font":
      if (t.value === 0) return undefined;
      return Font(0);
    case "Ideogram":
      if (t.value === 5) return undefined;
      return Ideogram(5);
    case "Bold":
    case "Faint":
      return NormalWeight;
    case "Italic":
    case "Fraktur":
      return NotEmphasis;
    case "Underline":
    case "Double_ul":
      return NotUnderline;
    case "Blink":
    case "Fast_blink":
      return NotBlink;
    case "Framed":
    case "Encircled":
      return NotFramed;
    case "Superscript":
    case "Subscript":
      return NotScript;
    case "Invert":
      return NotInvert;
    case "Hide":
      return NotHide;
    case "Strike":
      return NotStrike;
    case "Overline":
      return NotOverline;
    case "Variable_width":
      return FixedWidth;
    case "Normal_weight":
    case "Not_emphasis":
    case "Not_underline":
    case "Not_blink":
    case "Not_invert":
    case "Not_hide":
    case "Not_strike":
    case "Not_overline":
    case "Not_framed":
    case "Not_script":
    case "Fixed_width":
    case "Other":
      return undefined;
  }
};

export const overrides = (newAttr: T, oldAttr: T): boolean => {
  const isIntensity = (k: T["kind"]) => k === "Bold" || k === "Faint" || k === "Normal_weight";
  const isEmphasis = (k: T["kind"]) => k === "Italic" || k === "Not_emphasis" || k === "Fraktur";
  const isUnderline = (k: T["kind"]) => k === "Underline" || k === "Double_ul" || k === "Not_underline";
  const isBlink = (k: T["kind"]) => k === "Blink" || k === "Fast_blink" || k === "Not_blink";
  const isInvert = (k: T["kind"]) => k === "Invert" || k === "Not_invert";
  const isHide = (k: T["kind"]) => k === "Hide" || k === "Not_hide";
  const isStrike = (k: T["kind"]) => k === "Strike" || k === "Not_strike";
  const isOverline = (k: T["kind"]) => k === "Overline" || k === "Not_overline";
  const isFramed = (k: T["kind"]) => k === "Framed" || k === "Encircled" || k === "Not_framed";
  const isScript = (k: T["kind"]) => k === "Superscript" || k === "Subscript" || k === "Not_script";
  const isWidth = (k: T["kind"]) => k === "Variable_width" || k === "Fixed_width";

  if (newAttr.kind === "Reset") return true;
  const n = newAttr.kind;
  const o = oldAttr.kind;
  if (isIntensity(n) && isIntensity(o)) return true;
  if (isEmphasis(n) && isEmphasis(o)) return true;
  if (isUnderline(n) && isUnderline(o)) return true;
  if (isBlink(n) && isBlink(o)) return true;
  if (isInvert(n) && isInvert(o)) return true;
  if (isHide(n) && isHide(o)) return true;
  if (isStrike(n) && isStrike(o)) return true;
  if (isOverline(n) && isOverline(o)) return true;
  if (isFramed(n) && isFramed(o)) return true;
  if (isScript(n) && isScript(o)) return true;
  if (isWidth(n) && isWidth(o)) return true;
  if (n === "Fg" && o === "Fg") return true;
  if (n === "Bg" && o === "Bg") return true;
  if (n === "Ul_color" && o === "Ul_color") return true;
  if (n === "Font" && o === "Font") return true;
  if (n === "Ideogram" && o === "Ideogram") return true;
  return false;
};

const between = (n: number, low: number, high: number): boolean => low <= n && n <= high;

const ofColorCode = (code: readonly number[]): Color.T | undefined => {
  if (code.length === 2 && code[0] === 5) {
    const c = code[1]!;
    if (between(c, 0, 7)) return Color.sgr8Exn(c);
    if (between(c, 8, 15)) return Color.sgr8Exn(c - 8, true);
    if (between(c, 16, 231)) return Color.Rgb6Of(Color.Rgb6.ofCodeExn(c));
    if (between(c, 232, 255)) return Color.gray24Exn(c);
    return undefined;
  }
  if (code.length === 4 && code[0] === 2) {
    const r = code[1]!;
    const g = code[2]!;
    const b = code[3]!;
    if (between(r, 0, 255) && between(g, 0, 255) && between(b, 0, 255)) {
      return Color.rgb256Exn([r, g, b]);
    }
    return undefined;
  }
  return undefined;
};

export const ofCodes = (codes: readonly number[]): T => {
  if (codes.length === 1) {
    const c = codes[0]!;
    if (c === 0) return Reset;
    if (c === 1) return Bold;
    if (c === 2) return Faint;
    if (c === 3) return Italic;
    if (c === 4) return Underline;
    if (c === 5) return Blink;
    if (c === 6) return FastBlink;
    if (c === 7) return Invert;
    if (c === 8) return Hide;
    if (c === 9) return Strike;
    if (between(c, 10, 19)) return Font(c - 10);
    if (c === 20) return Fraktur;
    if (c === 21) return DoubleUl;
    if (c === 22) return NormalWeight;
    if (c === 23) return NotEmphasis;
    if (c === 24) return NotUnderline;
    if (c === 25) return NotBlink;
    if (c === 26) return VariableWidth;
    if (c === 27) return NotInvert;
    if (c === 28) return NotHide;
    if (c === 29) return NotStrike;
    if (between(c, 30, 37)) return Fg(Color.sgr8Exn(c - 30));
    if (c === 39) return Fg(Color.Default);
    if (between(c, 40, 47)) return Bg(Color.sgr8Exn(c - 40));
    if (c === 49) return Bg(Color.Default);
    if (c === 50) return FixedWidth;
    if (c === 51) return Framed;
    if (c === 52) return Encircled;
    if (c === 53) return Overline;
    if (c === 54) return NotFramed;
    if (c === 55) return NotOverline;
    if (c === 59) return UlColor(Color.Default);
    if (between(c, 60, 65)) return Ideogram(c - 60);
    if (c === 73) return Superscript;
    if (c === 74) return Subscript;
    if (c === 75) return NotScript;
    if (between(c, 90, 97)) return Fg(Color.sgr8Exn(c - 90, true));
    if (between(c, 100, 107)) return Bg(Color.sgr8Exn(c - 100, true));
    return Other(codes);
  }
  if (codes.length >= 1 && codes[0] === 38) {
    const color = ofColorCode(codes.slice(1));
    return color !== undefined ? Fg(color) : Other(codes);
  }
  if (codes.length >= 1 && codes[0] === 48) {
    const color = ofColorCode(codes.slice(1));
    return color !== undefined ? Bg(color) : Other(codes);
  }
  if (codes.length >= 1 && codes[0] === 58) {
    const color = ofColorCode(codes.slice(1));
    return color !== undefined ? UlColor(color) : Other(codes);
  }
  return Other(codes);
};

export const toCode = (t: T): readonly number[] => {
  switch (t.kind) {
    case "Reset":
      return [0];
    case "Bold":
      return [1];
    case "Faint":
      return [2];
    case "Italic":
      return [3];
    case "Underline":
      return [4];
    case "Blink":
      return [5];
    case "Fast_blink":
      return [6];
    case "Invert":
      return [7];
    case "Hide":
      return [8];
    case "Strike":
      return [9];
    case "Font":
      return [10 + t.value];
    case "Fraktur":
      return [20];
    case "Double_ul":
      return [21];
    case "Normal_weight":
      return [22];
    case "Not_emphasis":
      return [23];
    case "Not_underline":
      return [24];
    case "Not_blink":
      return [25];
    case "Variable_width":
      return [26];
    case "Not_invert":
      return [27];
    case "Not_hide":
      return [28];
    case "Not_strike":
      return [29];
    case "Fg":
      return Color.toFgCode(t.color);
    case "Bg":
      return Color.toBgCode(t.color);
    case "Fixed_width":
      return [50];
    case "Framed":
      return [51];
    case "Encircled":
      return [52];
    case "Overline":
      return [53];
    case "Not_framed":
      return [54];
    case "Not_overline":
      return [55];
    case "Ul_color":
      return Color.toUlCode(t.color);
    case "Ideogram":
      return [60 + t.value];
    case "Superscript":
      return [73];
    case "Subscript":
      return [74];
    case "Not_script":
      return [75];
    case "Other":
      return t.codes;
  }
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Reset":
      return "off";
    case "Bold":
      return "+bold";
    case "Faint":
      return "+faint";
    case "Italic":
      return "+italic";
    case "Underline":
      return "+uline";
    case "Blink":
      return "+blink";
    case "Fast_blink":
      return "+fastblink";
    case "Invert":
      return "+invert";
    case "Hide":
      return "+hide";
    case "Strike":
      return "+strike";
    case "Double_ul":
      return "+2uline";
    case "Overline":
      return "+overline";
    case "Normal_weight":
      return "-weight";
    case "Not_emphasis":
      return "-italic";
    case "Not_underline":
      return "-uline";
    case "Not_blink":
      return "-blink";
    case "Not_invert":
      return "-invert";
    case "Not_hide":
      return "-hide";
    case "Not_strike":
      return "-strike";
    case "Not_overline":
      return "-overline";
    case "Fg":
      return `fg:${Color.toStringHum(t.color)}`;
    case "Bg":
      return `bg:${Color.toStringHum(t.color)}`;
    case "Ul_color":
      return `ul:${Color.toStringHum(t.color)}`;
    case "Other":
      return `ANSI-SGR:${t.codes.map((c) => c.toString()).join(";")}`;
    case "Framed":
      return "+framed";
    case "Encircled":
      return "+encircled";
    case "Superscript":
      return "+superscript";
    case "Subscript":
      return "+subscript";
    case "Variable_width":
      return "+proportional_spacing";
    case "Fraktur":
      return "+fraktur";
    case "Not_framed":
      return "-framed";
    case "Not_script":
      return "-script";
    case "Fixed_width":
      return "-proportional_spacing";
    case "Font":
      if (t.value === 0) return "-font";
      return `+font:${t.value}`;
    case "Ideogram":
      if (t.value === 5) return "-ideogram";
      return `+ideogram:${t.value}`;
  }
};

export const toString = (t: T): string => {
  switch (t.kind) {
    case "Reset":
      return "0";
    case "Fg":
      if (t.color.kind === "Default") return "39";
      if (t.color.kind === "Standard") return String(30 + Color.Sgr8.toCode(t.color.value));
      return Color.toFgCode(t.color).map(String).join(";");
    case "Bg":
      if (t.color.kind === "Default") return "49";
      if (t.color.kind === "Standard") return String(40 + Color.Sgr8.toCode(t.color.value));
      return Color.toBgCode(t.color).map(String).join(";");
    case "Bold":
      return "1";
    case "Faint":
      return "2";
    case "Italic":
      return "3";
    case "Underline":
      return "4";
    case "Blink":
      return "5";
    case "Fast_blink":
      return "6";
    case "Invert":
      return "7";
    case "Hide":
      return "8";
    case "Strike":
      return "9";
    case "Double_ul":
      return "21";
    case "Overline":
      return "53";
    case "Normal_weight":
      return "22";
    case "Not_emphasis":
      return "23";
    case "Not_underline":
      return "24";
    case "Not_blink":
      return "25";
    case "Not_invert":
      return "27";
    case "Not_hide":
      return "28";
    case "Not_strike":
      return "29";
    case "Not_overline":
      return "55";
    case "Ul_color":
      return Color.toUlCode(t.color).map(String).join(";");
    case "Other":
      return t.codes.map(String).join(";");
    case "Framed":
      return "51";
    case "Encircled":
      return "52";
    case "Superscript":
      return "73";
    case "Subscript":
      return "74";
    case "Variable_width":
      return "26";
    case "Fraktur":
      return "20";
    case "Not_framed":
      return "54";
    case "Not_script":
      return "75";
    case "Fixed_width":
      return "50";
    case "Font":
      return String(t.value + 10);
    case "Ideogram":
      return String(t.value + 60);
  }
};

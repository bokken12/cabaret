import * as Control from "./control.js";
import * as Dsr from "./dsr.js";
import * as Hyperlink from "./hyperlink.js";
import * as Osc from "./osc.js";
import * as PrivateMode from "./private-mode.js";
import * as Style from "./style.js";
import * as UnknownEsc from "./unknown-esc.js";

export type Formatting =
  | { readonly kind: "Style"; readonly style: Style.T }
  | { readonly kind: "Hyperlink"; readonly hyperlink: Hyperlink.T };

export type Emulation =
  | { readonly kind: "Private_mode"; readonly value: PrivateMode.T }
  | { readonly kind: "Osc"; readonly value: Osc.T }
  | { readonly kind: "Dsr"; readonly value: Dsr.T };

export type T =
  | Formatting
  | Emulation
  | { readonly kind: "Control"; readonly value: Control.T }
  | { readonly kind: "Unknown"; readonly value: UnknownEsc.T };

export const Style_ = (style: Style.T): T => ({ kind: "Style", style });
export const HyperlinkOf = (hyperlink: Hyperlink.T): T => ({
  kind: "Hyperlink",
  hyperlink,
});
export const PrivateModeOf = (value: PrivateMode.T): T => ({
  kind: "Private_mode",
  value,
});
export const OscOf = (value: Osc.T): T => ({ kind: "Osc", value });
export const DsrOf = (value: Dsr.T): T => ({ kind: "Dsr", value });
export const ControlOf = (value: Control.T): T => ({ kind: "Control", value });
export const UnknownOf = (value: UnknownEsc.T): T => ({ kind: "Unknown", value });

export const isFormatting = (t: T): t is Formatting => t.kind === "Style" || t.kind === "Hyperlink";

export const isEmulation = (t: T): t is Emulation => t.kind === "Private_mode" || t.kind === "Osc" || t.kind === "Dsr";

const isControlFinalByte = (c: string): boolean => {
  switch (c) {
    case "A":
    case "B":
    case "C":
    case "D":
    case "E":
    case "F":
    case "G":
    case "H":
    case "J":
    case "K":
    case "S":
    case "T":
      return true;
    default:
      return false;
  }
};

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
  const unknown = (): T => UnknownOf(UnknownEsc.ofCsi(paramString, terminal, privatePrefix));
  if (privatePrefix === "?") {
    const pm = PrivateMode.ofCsiParams(parseParams(paramString), terminal);
    if (pm !== undefined) return PrivateModeOf(pm);
    return unknown();
  }
  if (privatePrefix !== undefined) return unknown();
  if (terminal === "m") {
    return Style_(Style.ofSgrParams(parseParams(paramString)));
  }
  if (terminal === "n") {
    const dsr = Dsr.ofParams(parseParams(paramString));
    if (dsr !== undefined) return DsrOf(dsr);
    return unknown();
  }
  if (isControlFinalByte(terminal)) {
    return ControlOf(Control.ofCsiParams(parseParams(paramString), terminal));
  }
  return unknown();
};

export const ofOscPayload = (payload: string): T => OscOf(Osc.ofPayload(payload));

export const toString = (t: T): string => {
  switch (t.kind) {
    case "Control":
      return Control.toString(t.value);
    case "Style":
      return Style.toString(t.style);
    case "Hyperlink":
      return Hyperlink.toString(t.hyperlink);
    case "Private_mode":
      return PrivateMode.toString(t.value);
    case "Osc":
      return Osc.toString(t.value);
    case "Dsr":
      return Dsr.toString(t.value);
    case "Unknown":
      return UnknownEsc.toString(t.value);
  }
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Control":
      return Control.toStringHum(t.value);
    case "Style":
      return Style.toStringHum(t.style);
    case "Hyperlink":
      return Hyperlink.toStringHum(t.hyperlink);
    case "Private_mode":
      return PrivateMode.toStringHum(t.value);
    case "Osc":
      return Osc.toStringHum(t.value);
    case "Dsr":
      return Dsr.toStringHum(t.value);
    case "Unknown":
      return UnknownEsc.toStringHum(t.value);
  }
};

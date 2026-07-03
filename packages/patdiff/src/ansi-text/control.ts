export type ClearLine = "To_line_end" | "To_line_start" | "Whole_line";
export type ClearScreen = "To_screen_end" | "To_screen_start" | "Whole_screen" | "Screen_and_scrollback";

export type T =
  | { readonly kind: "CursorUp"; readonly n: number | undefined }
  | { readonly kind: "CursorDown"; readonly n: number | undefined }
  | { readonly kind: "CursorForward"; readonly n: number | undefined }
  | { readonly kind: "CursorBackward"; readonly n: number | undefined }
  | { readonly kind: "CursorNextLine"; readonly n: number | undefined }
  | { readonly kind: "CursorPrevLine"; readonly n: number | undefined }
  | { readonly kind: "CursorToCol"; readonly n: number | undefined }
  | {
      readonly kind: "CursorToPos";
      readonly n: number | undefined;
      readonly m: number | undefined;
    }
  | { readonly kind: "EraseDisplay"; readonly value: ClearScreen | undefined }
  | { readonly kind: "EraseLine"; readonly value: ClearLine | undefined }
  | { readonly kind: "ScrollUp"; readonly n: number | undefined }
  | { readonly kind: "ScrollDown"; readonly n: number | undefined }
  | {
      readonly kind: "Unknown";
      readonly params: readonly (number | undefined)[];
      readonly terminal: string;
    };

export const CursorUp = (n: number | undefined): T => ({ kind: "CursorUp", n });
export const CursorDown = (n: number | undefined): T => ({ kind: "CursorDown", n });
export const CursorForward = (n: number | undefined): T => ({ kind: "CursorForward", n });
export const CursorBackward = (n: number | undefined): T => ({ kind: "CursorBackward", n });
export const CursorNextLine = (n: number | undefined): T => ({ kind: "CursorNextLine", n });
export const CursorPrevLine = (n: number | undefined): T => ({ kind: "CursorPrevLine", n });
export const CursorToCol = (n: number | undefined): T => ({ kind: "CursorToCol", n });
export const CursorToPos = (n: number | undefined, m: number | undefined): T => ({
  kind: "CursorToPos",
  n,
  m,
});
export const EraseDisplay = (value: ClearScreen | undefined): T => ({
  kind: "EraseDisplay",
  value,
});
export const EraseLine = (value: ClearLine | undefined): T => ({ kind: "EraseLine", value });
export const ScrollUp = (n: number | undefined): T => ({ kind: "ScrollUp", n });
export const ScrollDown = (n: number | undefined): T => ({ kind: "ScrollDown", n });
export const Unknown = (params: readonly (number | undefined)[], terminal: string): T => ({
  kind: "Unknown",
  params,
  terminal,
});

export const ofCsiParams = (params: readonly (number | undefined)[], terminal: string): T => {
  const n = params.length > 0 ? params[0] : undefined;
  const unknown = (): T => Unknown(params, terminal);
  switch (terminal) {
    case "A":
      return CursorUp(n);
    case "B":
      return CursorDown(n);
    case "C":
      return CursorForward(n);
    case "D":
      return CursorBackward(n);
    case "E":
      return CursorNextLine(n);
    case "F":
      return CursorPrevLine(n);
    case "G":
      return CursorToCol(n);
    case "H": {
      const m = params.length > 1 ? params[1] : undefined;
      return CursorToPos(n, m);
    }
    case "J":
      if (n === undefined) return EraseDisplay(undefined);
      switch (n) {
        case 0:
          return EraseDisplay("To_screen_end");
        case 1:
          return EraseDisplay("To_screen_start");
        case 2:
          return EraseDisplay("Whole_screen");
        case 3:
          return EraseDisplay("Screen_and_scrollback");
        default:
          return unknown();
      }
    case "K":
      if (n === undefined) return EraseLine(undefined);
      switch (n) {
        case 0:
          return EraseLine("To_line_end");
        case 1:
          return EraseLine("To_line_start");
        case 2:
          return EraseLine("Whole_line");
        default:
          return unknown();
      }
    case "S":
      return ScrollUp(n);
    case "T":
      return ScrollDown(n);
    default:
      return unknown();
  }
};

export const toString = (t: T): string => {
  switch (t.kind) {
    case "CursorUp":
      return t.n === undefined ? "\x1b[A" : `\x1b[${t.n}A`;
    case "CursorDown":
      return t.n === undefined ? "\x1b[B" : `\x1b[${t.n}B`;
    case "CursorForward":
      return t.n === undefined ? "\x1b[C" : `\x1b[${t.n}C`;
    case "CursorBackward":
      return t.n === undefined ? "\x1b[D" : `\x1b[${t.n}D`;
    case "CursorNextLine":
      return t.n === undefined ? "\x1b[E" : `\x1b[${t.n}E`;
    case "CursorPrevLine":
      return t.n === undefined ? "\x1b[F" : `\x1b[${t.n}F`;
    case "CursorToCol":
      return t.n === undefined ? "\x1b[G" : `\x1b[${t.n}G`;
    case "CursorToPos":
      if (t.n === undefined && t.m === undefined) return "\x1b[H";
      if (t.n !== undefined && t.m === undefined) return `\x1b[${t.n}H`;
      if (t.n === undefined && t.m !== undefined) return `\x1b[;${t.m}H`;
      return `\x1b[${t.n};${t.m}H`;
    case "EraseDisplay":
      if (t.value === undefined) return "\x1b[J";
      switch (t.value) {
        case "To_screen_end":
          return "\x1b[0J";
        case "To_screen_start":
          return "\x1b[1J";
        case "Whole_screen":
          return "\x1b[2J";
        case "Screen_and_scrollback":
          return "\x1b[3J";
      }
    case "EraseLine":
      if (t.value === undefined) return "\x1b[K";
      switch (t.value) {
        case "To_line_end":
          return "\x1b[0K";
        case "To_line_start":
          return "\x1b[1K";
        case "Whole_line":
          return "\x1b[2K";
      }
    case "ScrollUp":
      return t.n === undefined ? "\x1b[S" : `\x1b[${t.n}S`;
    case "ScrollDown":
      return t.n === undefined ? "\x1b[T" : `\x1b[${t.n}T`;
    case "Unknown": {
      const paramsStr = t.params.map((p) => (p === undefined ? "" : String(p))).join(";");
      return `\x1b[${paramsStr}${t.terminal}`;
    }
  }
};

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "CursorUp":
      return t.n === undefined ? "(CursorUp)" : `(CursorUp:${t.n})`;
    case "CursorDown":
      return t.n === undefined ? "(CursorDown)" : `(CursorDown:${t.n})`;
    case "CursorForward":
      return t.n === undefined ? "(CursorForward)" : `(CursorForward:${t.n})`;
    case "CursorBackward":
      return t.n === undefined ? "(CursorBackward)" : `(CursorBackward:${t.n})`;
    case "CursorNextLine":
      return t.n === undefined ? "(CursorNextLine)" : `(CursorNextLine:${t.n})`;
    case "CursorPrevLine":
      return t.n === undefined ? "(CursorPrevLine)" : `(CursorPrevLine:${t.n})`;
    case "CursorToCol":
      return t.n === undefined ? "(CursorToCol:1)" : `(CursorToCol:${t.n})`;
    case "CursorToPos":
      if (t.n === undefined && t.m === undefined) return "(CursorToPos:1;1)";
      if (t.n !== undefined && t.m === undefined) return `(CursorToPos:${t.n};1)`;
      if (t.n === undefined && t.m !== undefined) return `(CursorToPos:1;${t.m})`;
      return `(CursorToPos:${t.n};${t.m})`;
    case "EraseDisplay":
      if (t.value === undefined || t.value === "To_screen_end") return "(EraseScreen:ToEnd)";
      switch (t.value) {
        case "To_screen_start":
          return "(EraseScreen:ToStart)";
        case "Whole_screen":
          return "(EraseScreen)";
        case "Screen_and_scrollback":
          return "(EraseScreen:AndScrollback)";
      }
    case "EraseLine":
      if (t.value === undefined || t.value === "To_line_end") return "(EraseLine:ToEnd)";
      switch (t.value) {
        case "To_line_start":
          return "(EraseLine:ToStart)";
        case "Whole_line":
          return "(EraseLine)";
      }
    case "ScrollUp":
      return t.n === undefined ? "(ScrollUp)" : `(ScrollUp:${t.n})`;
    case "ScrollDown":
      return t.n === undefined ? "(ScrollDown)" : `(ScrollDown:${t.n})`;
    case "Unknown": {
      const paramsStr = t.params.map((p) => (p === undefined ? "" : String(p))).join(";");
      return `(ANSI-CSI:${paramsStr}${t.terminal})`;
    }
  }
};

export namespace Sgr8 {
  export type T = "Black" | "Red" | "Green" | "Yellow" | "Blue" | "Magenta" | "Cyan" | "White";

  export const ofCodeExn = (code: number): T => {
    switch (code) {
      case 0:
        return "Black";
      case 1:
        return "Red";
      case 2:
        return "Green";
      case 3:
        return "Yellow";
      case 4:
        return "Blue";
      case 5:
        return "Magenta";
      case 6:
        return "Cyan";
      case 7:
        return "White";
      default:
        throw new Error("Sgr8 code -- expected (0 <= code < 8)");
    }
  };

  export const toCode = (t: T): number => {
    switch (t) {
      case "Black":
        return 0;
      case "Red":
        return 1;
      case "Green":
        return 2;
      case "Yellow":
        return 3;
      case "Blue":
        return 4;
      case "Magenta":
        return 5;
      case "Cyan":
        return 6;
      case "White":
        return 7;
    }
  };

  export const toStringHum = (t: T): string => {
    switch (t) {
      case "Black":
        return "black";
      case "Red":
        return "red";
      case "Green":
        return "green";
      case "Yellow":
        return "yellow";
      case "Blue":
        return "blue";
      case "Magenta":
        return "magenta";
      case "Cyan":
        return "cyan";
      case "White":
        return "white";
    }
  };

  export const equal = (a: T, b: T): boolean => a === b;
}

export namespace Rgb6 {
  export interface T {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  }

  const check = (c: number): boolean => 0 <= c && c < 6;

  export const ofRgbExn = ([r, g, b]: readonly [number, number, number]): T => {
    if (!(check(r) && check(g) && check(b))) {
      throw new Error("Rgb6 (r, g, b) -- expected (0 <= r, g, b < 6)");
    }
    return { r, g, b };
  };

  export const ofCodeExn = (code: number): T => {
    if (!(16 <= code && code < 232)) {
      throw new Error("Rgb6 code -- expected (16 <= code < 232)");
    }
    const rgb = code - 16;
    return { r: Math.floor(rgb / 36), g: Math.floor(rgb / 6) % 6, b: rgb % 6 };
  };

  export const toRgb = (t: T): readonly [number, number, number] => [t.r, t.g, t.b];
  export const toCode = (t: T): number => 16 + 36 * t.r + 6 * t.g + t.b;
  export const toStringHum = (t: T): string => `rgb6-${t.r}-${t.g}-${t.b}`;
  export const equal = (a: T, b: T): boolean => a.r === b.r && a.g === b.g && a.b === b.b;
}

export namespace Gray24 {
  export interface T {
    readonly level: number;
  }

  export const ofLevelExn = (level: number): T => {
    if (!(0 <= level && level < 24)) {
      throw new Error("Gray24 level -- expected (0 <= level < 24)");
    }
    return { level };
  };

  export const ofCodeExn = (code: number): T => {
    if (!(232 <= code && code < 256)) {
      throw new Error("Gray24 code -- expected (232 <= code < 256)");
    }
    return { level: code - 232 };
  };

  export const toLevel = (t: T): number => t.level;
  export const toCode = (t: T): number => 232 + t.level;
  export const toStringHum = (t: T): string => `gray-${t.level}`;
  export const equal = (a: T, b: T): boolean => a.level === b.level;
}

export namespace Rgb256 {
  export interface T {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  }

  const check = (c: number): boolean => 0 <= c && c < 256;

  export const ofRgbExn = ([r, g, b]: readonly [number, number, number]): T => {
    if (!(check(r) && check(g) && check(b))) {
      throw new Error("Rgb6 (r, g, b) -- expected (0 <= r, g, b < 256)");
    }
    return { r, g, b };
  };

  export const toRgb = (t: T): readonly [number, number, number] => [t.r, t.g, t.b];
  export const toStringHum = (t: T): string => `rgb256-${t.r}-${t.g}-${t.b}`;
  export const equal = (a: T, b: T): boolean => a.r === b.r && a.g === b.g && a.b === b.b;
}

export type T =
  | { readonly kind: "Default" }
  | { readonly kind: "Standard"; readonly value: Sgr8.T }
  | { readonly kind: "Bright"; readonly value: Sgr8.T }
  | { readonly kind: "Rgb6"; readonly value: Rgb6.T }
  | { readonly kind: "Gray24"; readonly value: Gray24.T }
  | { readonly kind: "Rgb256"; readonly value: Rgb256.T };

export const Default: T = { kind: "Default" };
export const Standard = (value: Sgr8.T): T => ({ kind: "Standard", value });
export const Bright = (value: Sgr8.T): T => ({ kind: "Bright", value });
export const Rgb6Of = (value: Rgb6.T): T => ({ kind: "Rgb6", value });
export const Gray24Of = (value: Gray24.T): T => ({ kind: "Gray24", value });
export const Rgb256Of = (value: Rgb256.T): T => ({ kind: "Rgb256", value });

export const equal = (a: T, b: T): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Default":
      return true;
    case "Standard":
      return Sgr8.equal(a.value, (b as typeof a).value);
    case "Bright":
      return Sgr8.equal(a.value, (b as typeof a).value);
    case "Rgb6":
      return Rgb6.equal(a.value, (b as typeof a).value);
    case "Gray24":
      return Gray24.equal(a.value, (b as typeof a).value);
    case "Rgb256":
      return Rgb256.equal(a.value, (b as typeof a).value);
  }
};

export const sgr8Exn = (code: number, bright = false): T =>
  bright ? Bright(Sgr8.ofCodeExn(code)) : Standard(Sgr8.ofCodeExn(code));

export const rgb6Exn = (rgb: readonly [number, number, number]): T => Rgb6Of(Rgb6.ofRgbExn(rgb));
export const gray24Exn = (code: number): T => Gray24Of(Gray24.ofCodeExn(code));
export const rgb256Exn = (rgb: readonly [number, number, number]): T => Rgb256Of(Rgb256.ofRgbExn(rgb));

export const toStringHum = (t: T): string => {
  switch (t.kind) {
    case "Default":
      return "default";
    case "Standard":
      return Sgr8.toStringHum(t.value);
    case "Bright":
      if (t.value === "Black") return "gray";
      return `bright-${Sgr8.toStringHum(t.value)}`;
    case "Rgb6":
      return Rgb6.toStringHum(t.value);
    case "Gray24":
      return Gray24.toStringHum(t.value);
    case "Rgb256":
      return Rgb256.toStringHum(t.value);
  }
};

export const toFgCode = (t: T): readonly number[] => {
  switch (t.kind) {
    case "Default":
      return [39];
    case "Standard":
      return [30 + Sgr8.toCode(t.value)];
    case "Bright":
      return [90 + Sgr8.toCode(t.value)];
    case "Rgb6":
      return [38, 5, Rgb6.toCode(t.value)];
    case "Gray24":
      return [38, 5, Gray24.toCode(t.value)];
    case "Rgb256": {
      const [r, g, b] = Rgb256.toRgb(t.value);
      return [38, 2, r, g, b];
    }
  }
};

export const toBgCode = (t: T): readonly number[] => {
  switch (t.kind) {
    case "Default":
      return [49];
    case "Standard":
      return [40 + Sgr8.toCode(t.value)];
    case "Bright":
      return [100 + Sgr8.toCode(t.value)];
    case "Rgb6":
      return [48, 5, Rgb6.toCode(t.value)];
    case "Gray24":
      return [48, 5, Gray24.toCode(t.value)];
    case "Rgb256": {
      const [r, g, b] = Rgb256.toRgb(t.value);
      return [48, 2, r, g, b];
    }
  }
};

export const toUlCode = (t: T): readonly number[] => {
  switch (t.kind) {
    case "Default":
      return [59];
    case "Standard":
      return [58, 5, Sgr8.toCode(t.value)];
    case "Bright":
      return [58, 5, 8 + Sgr8.toCode(t.value)];
    case "Rgb6":
      return [58, 5, Rgb6.toCode(t.value)];
    case "Gray24":
      return [58, 5, Gray24.toCode(t.value)];
    case "Rgb256": {
      const [r, g, b] = Rgb256.toRgb(t.value);
      return [58, 2, r, g, b];
    }
  }
};

export const black: T = Standard("Black");
export const red: T = Standard("Red");
export const green: T = Standard("Green");
export const yellow: T = Standard("Yellow");
export const blue: T = Standard("Blue");
export const magenta: T = Standard("Magenta");
export const cyan: T = Standard("Cyan");
export const white: T = Standard("White");
export const gray: T = Bright("Black");

export const defaultTextColorFor = (bg: T): T => {
  switch (bg.kind) {
    case "Standard":
      switch (bg.value) {
        case "White":
        case "Yellow":
          return black;
        default:
          return white;
      }
    case "Bright":
      switch (bg.value) {
        case "White":
        case "Yellow":
        case "Green":
        case "Cyan":
          return black;
        case "Black":
        case "Red":
        case "Blue":
        case "Magenta":
          return white;
      }
    case "Rgb6": {
      const sum = bg.value.r + bg.value.g + bg.value.b;
      if (sum < 6) return white;
      if (sum < 12) return Default;
      return black;
    }
    case "Gray24":
      if (bg.value.level < 8) return white;
      if (bg.value.level < 16) return Default;
      return black;
    case "Rgb256": {
      const sum = bg.value.r + bg.value.g + bg.value.b;
      if (sum < 256) return white;
      if (sum < 512) return Default;
      return black;
    }
    case "Default":
      return Default;
  }
};

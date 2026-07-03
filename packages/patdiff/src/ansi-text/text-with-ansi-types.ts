import type * as Ansi from "./ansi.js";
import type * as Text from "./text.js";

export type Element = Ansi.T | { readonly kind: "Text"; readonly text: Text.T };

export type T = readonly Element[];

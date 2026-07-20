import type { Page } from "cabaret-views";

export type PageKind = Page["kind"];

export type Command =
  | "open-target"
  | "toggle-fold"
  | "back"
  | "refresh"
  | "help"
  | "review"
  | "diffs"
  | "mark"
  | "show-parent"
  | "show-child"
  | "up"
  | "down"
  | "half-up"
  | "half-down"
  | "top"
  | "bottom";

export interface Binding {
  /** The chord, each element a `keyName`. No binding's chord may prefix another's. */
  readonly keys: readonly string[];
  readonly command: Command;
  readonly label: string;
  /** Page kinds the binding answers on; unset answers everywhere. */
  readonly pages?: readonly PageKind[] | undefined;
}

export const KEYMAP: readonly Binding[] = [
  { keys: ["enter"], command: "open-target", label: "Open Target at Cursor" },
  { keys: ["tab"], command: "toggle-fold", label: "Toggle Fold" },
  { keys: ["q"], command: "back", label: "Close Page" },
  { keys: ["R"], command: "refresh", label: "Refresh" },
  { keys: ["?"], command: "help", label: "Keybindings" },
  { keys: ["r"], command: "review", label: "Review", pages: ["show"] },
  { keys: ["d"], command: "diffs", label: "Review Diffs", pages: ["show", "review"] },
  { keys: ["!", "m"], command: "mark", label: "Mark Reviewed", pages: ["diff", "review"] },
  { keys: ["^"], command: "show-parent", label: "Show Parent", pages: ["show"] },
  { keys: ["$"], command: "show-child", label: "Show Child", pages: ["show"] },
  { keys: ["j"], command: "down", label: "Down" },
  { keys: ["down"], command: "down", label: "Down" },
  { keys: ["k"], command: "up", label: "Up" },
  { keys: ["up"], command: "up", label: "Up" },
  { keys: ["ctrl+d"], command: "half-down", label: "Half Page Down" },
  { keys: ["pagedown"], command: "half-down", label: "Half Page Down" },
  { keys: ["ctrl+u"], command: "half-up", label: "Half Page Up" },
  { keys: ["pageup"], command: "half-up", label: "Half Page Up" },
  { keys: ["g"], command: "top", label: "Top" },
  { keys: ["G"], command: "bottom", label: "Bottom" },
];

// A chord that prefixes another could fire before the longer one finishes,
// so the keymap refuses the ambiguity outright.
for (const shorter of KEYMAP) {
  for (const longer of KEYMAP) {
    if (
      shorter !== longer &&
      shorter.keys.length < longer.keys.length &&
      shorter.keys.every((key, i) => longer.keys[i] === key)
    ) {
      throw new Error(`binding ${shorter.keys.join(" ")} prefixes ${longer.keys.join(" ")}`);
    }
  }
}

/** The bindings answering on a page of `kind`, in keymap order. */
export function bindingsFor(kind: PageKind): readonly Binding[] {
  return KEYMAP.filter(({ pages }) => pages === undefined || pages.includes(kind));
}

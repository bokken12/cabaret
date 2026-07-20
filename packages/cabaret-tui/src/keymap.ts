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
  | "select"
  | "step-up"
  | "step-down"
  | "step-outside"
  | "act-as"
  | "rebase"
  | "land"
  | "rename"
  | "reparent"
  | "set-owner"
  | "widen-reviewing"
  | "disable-reviewing"
  | "toggle-archived"
  | "goto-workspace"
  | "add-workspace"
  | "remove-workspace"
  | "create-child"
  | "create-parent"
  | "fetch"
  | "sync"
  | "up"
  | "down"
  | "left"
  | "right"
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
  /** The VS Code command this binding mirrors; the keymap test holds the two hosts together. */
  readonly counterpart?: string | undefined;
}

const ACTION_PAGES: readonly PageKind[] = ["home", "review", "show"];

export const KEYMAP: readonly Binding[] = [
  { keys: ["enter"], command: "open-target", label: "Open Target at Cursor", counterpart: "cabaret.openTarget" },
  { keys: ["tab"], command: "toggle-fold", label: "Toggle Fold", counterpart: "editor.toggleFold" },
  { keys: ["q"], command: "back", label: "Close Page", counterpart: "workbench.action.closeActiveEditor" },
  { keys: ["R"], command: "refresh", label: "Refresh", counterpart: "cabaret.refresh" },
  { keys: ["?"], command: "help", label: "Keybindings", counterpart: "cabaret.help" },
  { keys: ["r"], command: "review", label: "Review", pages: ["show"], counterpart: "cabaret.review" },
  {
    keys: ["d"],
    command: "diffs",
    label: "Review Diffs",
    pages: ["show", "review"],
    counterpart: "cabaret.reviewDiffs",
  },
  {
    keys: ["!", "m"],
    command: "mark",
    label: "Mark Reviewed",
    pages: ["diff", "review"],
    counterpart: "cabaret.markReviewed",
  },
  { keys: ["V"], command: "select", label: "Select Changes", pages: ["home"] },
  { keys: ["^"], command: "step-up", label: "Step Up", pages: ["diff", "show"], counterpart: "cabaret.stepUp" },
  { keys: ["$"], command: "step-down", label: "Step Down", pages: ["diff", "show"], counterpart: "cabaret.stepDown" },
  {
    keys: ["esc"],
    command: "step-outside",
    label: "Step Outside",
    pages: ["diff", "diffs", "review", "show"],
    counterpart: "cabaret.stepOutside",
  },
  { keys: ["@"], command: "act-as", label: "Act as User", counterpart: "cabaret.actAs" },
  { keys: ["!", "r", "b"], command: "rebase", label: "Rebase", pages: ACTION_PAGES, counterpart: "cabaret.rebase" },
  { keys: ["!", "l"], command: "land", label: "Land", counterpart: "cabaret.land" },
  { keys: ["!", "r", "n"], command: "rename", label: "Rename", pages: ACTION_PAGES, counterpart: "cabaret.rename" },
  {
    keys: ["!", "r", "p"],
    command: "reparent",
    label: "Reparent",
    pages: ACTION_PAGES,
    counterpart: "cabaret.reparent",
  },
  { keys: ["!", "o"], command: "set-owner", label: "Set Owner", pages: ACTION_PAGES, counterpart: "cabaret.setOwner" },
  {
    keys: ["!", "v"],
    command: "widen-reviewing",
    label: "Widen Reviewing",
    pages: ACTION_PAGES,
    counterpart: "cabaret.widenReviewing",
  },
  {
    keys: ["!", "d"],
    command: "disable-reviewing",
    label: "Disable Reviewing",
    pages: ACTION_PAGES,
    counterpart: "cabaret.disableReviewing",
  },
  {
    keys: ["!", "a"],
    command: "toggle-archived",
    label: "Toggle Archived",
    pages: ACTION_PAGES,
    counterpart: "cabaret.toggleArchived",
  },
  {
    keys: ["!", "g"],
    command: "goto-workspace",
    label: "Go to Workspace",
    pages: ACTION_PAGES,
    counterpart: "cabaret.gotoWorkspace",
  },
  {
    keys: ["!", "w", "a"],
    command: "add-workspace",
    label: "Add Workspace",
    pages: ACTION_PAGES,
    counterpart: "cabaret.addWorkspace",
  },
  {
    keys: ["!", "w", "d"],
    command: "remove-workspace",
    label: "Remove Workspace",
    pages: ACTION_PAGES,
    counterpart: "cabaret.removeWorkspace",
  },
  { keys: ["!", "c"], command: "create-child", label: "Create Child", counterpart: "cabaret.createChild" },
  { keys: ["!", "p"], command: "create-parent", label: "Create Parent", counterpart: "cabaret.createParent" },
  { keys: ["F"], command: "fetch", label: "Fetch Remote Activity", counterpart: "cabaret.fetch" },
  { keys: ["S"], command: "sync", label: "Sync Change", counterpart: "cabaret.sync" },
  { keys: ["j"], command: "down", label: "Down" },
  { keys: ["down"], command: "down", label: "Down" },
  { keys: ["k"], command: "up", label: "Up" },
  { keys: ["up"], command: "up", label: "Up" },
  { keys: ["h"], command: "left", label: "Left" },
  { keys: ["left"], command: "left", label: "Left" },
  { keys: ["l"], command: "right", label: "Right" },
  { keys: ["right"], command: "right", label: "Right" },
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

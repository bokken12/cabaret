/**
 * The keybinding list behind `?`, read from the extension's own manifest so
 * `contributes.keybindings` stays the single place bindings are declared.
 * The manifest's `key` and `when` strings follow a fixed grammar; anything
 * this module does not recognize throws, so a binding written outside the
 * grammar fails the manifest test rather than silently missing from help.
 */

import type { Page } from "cabaret-views";

/** The slice of the extension manifest that help reads. */
export type Manifest = {
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly title: string }[];
    readonly keybindings: readonly { readonly command: string; readonly key: string; readonly when: string }[];
  };
};

/** One binding as help presents it: pretty keys and the command's title. */
export type HelpEntry = {
  readonly keys: string;
  readonly command: string;
  readonly label: string;
};

type PageKind = Page["kind"];

/** The mapped type keeps this in step with `Page`, so scope parsing rejects page kinds that do not exist. */
const PAGE_KINDS: { readonly [K in PageKind]: true } = {
  todo: true,
  show: true,
  review: true,
  diffs: true,
  diff: true,
};

function parsePageKind(kind: string): PageKind {
  if (!(kind in PAGE_KINDS)) {
    throw new Error(`keybinding scoped to an unknown page kind: ${kind}`);
  }
  return kind as PageKind;
}

/** Where a binding applies: every cabaret page, or the page kinds it names. */
type Scope = "all" | readonly PageKind[];

/** Every binding guards against vim reading input; scopes sit between this prefix and suffix. */
const WHEN_PREFIX = "editorTextFocus && ";
const WHEN_SUFFIX =
  " && (!vim.active || vim.mode == 'Normal' || vim.mode == 'Visual' || vim.mode == 'VisualLine' || vim.mode == 'VisualBlock')";

function parseScope(when: string): Scope {
  if (!when.startsWith(WHEN_PREFIX) || !when.endsWith(WHEN_SUFFIX)) {
    throw new Error(`keybinding when clause is missing the standard guards: ${when}`);
  }
  const scope = when.slice(WHEN_PREFIX.length, when.length - WHEN_SUFFIX.length);
  if (scope === "resourceScheme == cabaret") {
    return "all";
  }
  const chain = scope.startsWith("(") && scope.endsWith(")") ? scope.slice(1, -1) : scope;
  return chain.split(" || ").map((clause) => {
    const page = /^cabaret\.page == '(\w+)'$/.exec(clause)?.[1];
    if (page === undefined) {
      throw new Error(`unrecognized keybinding scope: ${scope}`);
    }
    return parsePageKind(page);
  });
}

function applies(scope: Scope, page: PageKind): boolean {
  return scope === "all" || scope.includes(page);
}

/** What shift makes of a US-layout key, for showing `shift+1 r b` as `! r b`. */
const SHIFTED: { readonly [key: string]: string } = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "/": "?",
};

function prettyChord(chord: string): string {
  if (!chord.startsWith("shift+")) {
    return chord;
  }
  const key = chord.slice("shift+".length);
  if (/^[a-z]$/.test(key)) {
    return key.toUpperCase();
  }
  const shifted = SHIFTED[key];
  if (shifted === undefined) {
    throw new Error(`no shifted form known for key: ${chord}`);
  }
  return shifted;
}

/** Commands help lists that are not the extension's own, so carry no manifest title. */
const FOREIGN_TITLES: { readonly [command: string]: string } = {
  "editor.toggleFold": "Toggle Fold",
  "workbench.action.closeActiveEditor": "Close Page",
};

function label(manifest: Manifest, command: string): string {
  const title = manifest.contributes.commands.find((entry) => entry.command === command)?.title;
  if (title !== undefined) {
    const stripped = title.replace(/^Cabaret: /, "");
    if (stripped === title) {
      throw new Error(`command title is missing the Cabaret prefix: ${title}`);
    }
    return stripped;
  }
  const foreign = FOREIGN_TITLES[command];
  if (foreign === undefined) {
    throw new Error(`no title known for bound command: ${command}`);
  }
  return foreign;
}

/**
 * The bindings that apply on `page`, in manifest order. Every binding is
 * parsed regardless of the page asked about, so one malformed entry fails
 * loudly everywhere.
 */
export function pageHelp(manifest: Manifest, page: PageKind): HelpEntry[] {
  return manifest.contributes.keybindings
    .map((binding) => ({
      scope: parseScope(binding.when),
      entry: {
        keys: binding.key.split(" ").map(prettyChord).join(" "),
        command: binding.command,
        label: label(manifest, binding.command),
      },
    }))
    .filter(({ scope }) => applies(scope, page))
    .map(({ entry }) => entry);
}

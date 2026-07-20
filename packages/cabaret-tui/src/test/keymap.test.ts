import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type Binding, KEYMAP } from "../keymap.js";

interface Manifest {
  readonly contributes: {
    readonly keybindings: readonly { readonly key: string; readonly command: string; readonly when: string }[];
  };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../../cabaret-vscode/package.json", import.meta.url), "utf8"),
) as Manifest;

/** VS Code commands the TUI does not answer yet; drift past this list fails the test. */
const PENDING = new Set(["cabaret.stepOutside", "cabaret.stepUp", "cabaret.stepDown", "cabaret.actAs"]);

/** `shift+<key>` chords, spelled as the character the shift produces on a US layout. */
const SHIFTED: Readonly<Record<string, string>> = {
  "1": "!",
  "2": "@",
  "4": "$",
  "6": "^",
  "/": "?",
};

/** A VS Code chord as the TUI names its keys: `shift+1 r b` becomes `! r b`. */
function tuiKeys(key: string): readonly string[] {
  return key.split(" ").map((stroke) => {
    const shifted = /^shift\+(.+)$/.exec(stroke)?.[1];
    if (shifted === undefined) {
      return stroke;
    }
    const spelled = SHIFTED[shifted] ?? (/^[a-z]$/.test(shifted) ? shifted.toUpperCase() : undefined);
    if (spelled === undefined) {
      throw new Error(`no TUI spelling for ${stroke}`);
    }
    return spelled;
  });
}

/** The page kinds a `when` clause scopes to, or "all" for every cabaret page. */
function scope(when: string): "all" | readonly string[] {
  if (when.includes("resourceScheme == cabaret")) {
    return "all";
  }
  const pages = [...when.matchAll(/cabaret\.page == '(\w+)'/g)].map((match) => match[1] ?? "").sort();
  if (pages.length === 0) {
    throw new Error(`no TUI reading of when clause: ${when}`);
  }
  return pages;
}

test("every VS Code binding is the TUI's too, chord for chord and page for page", () => {
  const byCounterpart = new Map<string, Binding>();
  for (const binding of KEYMAP) {
    if (binding.counterpart !== undefined) {
      expect(byCounterpart.has(binding.counterpart), `${binding.counterpart} mirrored twice`).toBe(false);
      byCounterpart.set(binding.counterpart, binding);
    }
  }
  for (const { key, command, when } of manifest.contributes.keybindings) {
    if (PENDING.has(command)) {
      expect(byCounterpart.has(command), `${command} is pending but the keymap mirrors it`).toBe(false);
      continue;
    }
    const binding = byCounterpart.get(command);
    expect(binding, `${command} has no TUI counterpart`).toBeDefined();
    if (binding === undefined) {
      continue;
    }
    expect(binding.keys, `${command} chord`).toEqual(tuiKeys(key));
    const pages = scope(when);
    if (pages === "all") {
      expect(binding.pages, `${command} scope`).toBeUndefined();
    } else {
      expect([...(binding.pages ?? [])].sort(), `${command} scope`).toEqual(pages);
    }
  }
});

test("every mirrored TUI binding still exists in the VS Code manifest", () => {
  const commands = new Set(manifest.contributes.keybindings.map(({ command }) => command));
  for (const binding of KEYMAP) {
    if (binding.counterpart !== undefined) {
      expect(commands.has(binding.counterpart), `${binding.counterpart} left the manifest`).toBe(true);
    }
  }
  for (const command of PENDING) {
    expect(commands.has(command), `pending ${command} left the manifest`).toBe(true);
  }
});

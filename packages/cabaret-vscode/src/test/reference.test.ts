import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { allBindings, type Manifest } from "../help.js";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;

const HEADER =
  "# Cabaret VS Code Keybindings\n\n" +
  "<!-- Generated from the extension manifest; do not edit by hand. Regenerate with `pnpm test -u`. -->\n\n" +
  "The bindings contributed by `cabaret-vscode`, in manifest order. Keys are\n" +
  "written as the character typed (`!` is `shift+1`, `^` is `shift+6`); a\n" +
  "multi-key chord is consecutive keystrokes. `?` on any cabaret page lists\n" +
  "the bindings that apply there. `docs/keybindings.md` explains how keys\n" +
  "are chosen.";

type Row = readonly [keys: string, action: string, pages: string];

function renderTable(header: Row, rows: readonly Row[]): string {
  const cells = [header, ...rows];
  const w0 = Math.max(...cells.map((row) => row[0].length));
  const w1 = Math.max(...cells.map((row) => row[1].length));
  const w2 = Math.max(...cells.map((row) => row[2].length));
  const line = ([a, b, c]: Row) => `| ${a.padEnd(w0)} | ${b.padEnd(w1)} | ${c.padEnd(w2)} |`;
  const rule = line(["-".repeat(w0), "-".repeat(w1), "-".repeat(w2)]);
  return [line(header), rule, ...rows.map(line)].join("\n");
}

function renderReference(): string {
  const rows = allBindings(manifest).map(
    (binding): Row => [
      `\`${binding.keys}\``,
      binding.label,
      binding.scope === "all" ? "all" : binding.scope.join(", "),
    ],
  );
  return `${HEADER}\n\n${renderTable(["Keys", "Action", "Pages"], rows)}\n`;
}

// Snapshots the bindings to a committed file so the key surface evolves
// through reviewable diffs.
test("keybindings reference matches keybindings-reference.md", async () => {
  await expect(renderReference()).toMatchFileSnapshot("../../keybindings-reference.md");
});

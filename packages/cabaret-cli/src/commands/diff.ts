import { buildCommand } from "@stricli/core";
import { changeBase, changeTip, readConfig, renderDiff } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, contextFlag, resolveChange, selectFiles } from "./shared.js";

export const diff = buildCommand({
  docs: {
    brief: "Show a change's diff",
    fullDescription:
      "Show a change's diff: each changed file, base to tip. Arguments " +
      "narrow what is shown — a path, or a gitignore-style pattern against " +
      "repo-relative paths.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "files or patterns to show (defaults to every changed file)",
        placeholder: "file",
        parse: String,
      },
    },
    flags: {
      change: changeFlag("diff"),
      context: contextFlag,
    },
  },
  async func(this: LocalContext, flags: { change?: string; context?: number }, ...args: string[]) {
    const backend = await this.backend();
    // Config is read even when the flag preempts it, so a misconfigured
    // cabaret.* key fails the same way on every invocation.
    const context = flags.context ?? (await readConfig(backend)).context;
    const { change, entries } = await resolveChange(backend, flags.change);
    const [base, tip] = await Promise.all([changeBase(backend, change, entries), changeTip(backend, change, entries)]);
    const changed = await backend.changedFiles(base, tip);
    const byPath = new Map(changed.map((file) => [file.path, file]));
    const moves = new Map(
      changed.flatMap(({ path, movedFrom }) => (movedFrom === undefined ? [] : [[movedFrom, path] as const])),
    );
    const selected = selectFiles(
      backend,
      changed.map(({ path }) => path),
      args,
      false,
      "changed file",
    );
    // A moved file answers to its old name too, so the diff shown is the
    // move, not a bare deletion.
    const files = [...new Set(selected.map((file) => (byPath.has(file) ? file : (moves.get(file) ?? file))))];
    // Stricli's process type omits isTTY, but the runtime process underneath has it.
    const color = (this.process.stdout as { isTTY?: boolean }).isTTY === true;
    let separate = false;
    for (const file of files) {
      const movedFrom = byPath.get(file)?.movedFrom;
      const [prev, next] = await Promise.all([backend.readFile(base, movedFrom ?? file), backend.readFile(tip, file)]);
      this.process.stdout.write(
        `${separate ? "\n" : ""}${movedFrom === undefined ? file : `${movedFrom} -> ${file}`} in ${change}\n\n`,
      );
      separate = true;
      const rendered = renderDiff(file, prev, next, color, context);
      this.process.stdout.write(rendered === "" ? "No differences.\n" : rendered);
    }
  },
});

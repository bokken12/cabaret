import { buildCommand } from "@stricli/core";
import { changeBase, changeTip, conflictMarkers, lookupChange } from "cabaret-core";
import type { LocalContext } from "../context.js";

export const conflicts = buildCommand({
  docs: {
    brief: "Show a change's unresolved conflict markers",
    fullDescription:
      "Show each conflict marker left in a change's files, as file:line: " +
      "text. A rebase that conflicts commits the markers in place; this " +
      "lists what remains to fix.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to inspect (defaults to current)",
          placeholder: "change",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: string) {
    const backend = await this.backend();
    const target = change === undefined ? await backend.currentChange() : backend.parseName(change);
    const entries = (await lookupChange(backend, target))?.entries ?? [];
    const base = await changeBase(backend, target, entries);
    const tip = await changeTip(backend, target, entries);
    for (const { path: file } of await backend.changedFiles(base, tip)) {
      const content = await backend.readFile(tip, file);
      if (content === undefined) {
        continue;
      }
      for (const { line, text } of conflictMarkers(content)) {
        this.process.stdout.write(`${file}:${line}: ${text}\n`);
      }
    }
  },
});

import { buildCommand } from "@stricli/core";
import type { LocalContext } from "../context.js";

export const commit = buildCommand({
  docs: {
    brief: "Commit the workspace's edits to the current change",
    fullDescription:
      "Commit the workspace's edits — modified, added, and deleted files " +
      "alike — to the current change in one step, with no separate staging " +
      "and no message to compose: the change is the reviewable unit, so its " +
      "commits just carry its name. Arguments narrow what is committed to " +
      "the named files or patterns.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "files or patterns to commit (defaults to every edit)",
        placeholder: "file",
        parse: String,
      },
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, ...args: string[]) {
    const backend = await this.backend();
    const change = await backend.currentChange();
    await backend.commit(
      change,
      args.map((raw) => backend.resolveFile(raw)),
    );
  },
});

import { buildCommand } from "@stricli/core";
import type { LocalContext } from "../context.js";
import { pushTip, resolveChange, selectFiles } from "./shared.js";

export const commit = buildCommand({
  docs: {
    brief: "Commit the workspace's edits to the current change",
    fullDescription:
      "Commit the workspace's edits — modified, added, and deleted files " +
      "alike — to the current change in one step, with no separate staging " +
      "and no message to compose: the change is the reviewable unit, so its " +
      "commits just carry its name. Arguments narrow what is committed — " +
      "a file or directory, or a gitignore-style pattern against " +
      "repo-relative paths.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "files, directories, or patterns to commit (defaults to every edit)",
        placeholder: "file",
        parse: String,
      },
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, ...args: string[]) {
    const backend = await this.backend();
    const { change } = await resolveChange(backend, undefined);
    const files = selectFiles(backend, await backend.editedFiles(), args, true, "edit");
    await backend.commit(change, files);
    await pushTip(this, backend, change);
  },
});

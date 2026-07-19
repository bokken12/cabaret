import { buildCommand } from "@stricli/core";
import { UserError } from "cabaret-core";
import type { LocalContext } from "../context.js";

/** Parse a message argument, rejecting the empty string. */
function parseMessage(raw: string): string {
  if (raw === "") {
    throw new UserError("message must be nonempty");
  }
  return raw;
}

export const commit = buildCommand({
  docs: {
    brief: "Commit the workspace's edits to the current change",
    fullDescription:
      "Commit the workspace's edits — modified, added, and deleted files " +
      "alike — to the current change in one step, with no separate staging " +
      "and no message to compose: the change is the reviewable unit, so its " +
      "commits carry its name. Arguments narrow what is committed to the " +
      "named files or patterns.",
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
    flags: {
      message: {
        kind: "parsed",
        parse: parseMessage,
        brief: "Message recorded on the commit (defaults to the change's name)",
        optional: true,
      },
    },
    aliases: { m: "message" },
  },
  async func(this: LocalContext, flags: { message?: string }, ...args: string[]) {
    const backend = await this.backend();
    // The change resolves first even when a message preempts its name:
    // committing from a detached workspace would record work no change holds.
    const change = await backend.currentChange();
    await backend.commit(
      flags.message ?? change,
      args.map((raw) => backend.resolveFile(raw)),
    );
  },
});

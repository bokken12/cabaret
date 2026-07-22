import { buildCommand } from "@stricli/core";
import { UserError } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

/** Parse a comment-text argument, rejecting the empty string. */
function parseCommentText(raw: string): string {
  if (raw === "") {
    throw new UserError("comment must be nonempty");
  }
  return raw;
}

export const comment = buildCommand({
  docs: {
    brief: "Add a comment to a change",
    fullDescription:
      "Add a comment to a change. Appends one `comment` entry to the change's " + "log; `show` displays the comments.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the comment text", placeholder: "text", parse: parseCommentText }],
    },
    flags: { change: changeFlag("comment on") },
  },
  async func(this: LocalContext, flags: { change?: string }, text: string) {
    const backend = await this.backend();
    const { change } = await resolveChange(backend, flags.change);
    await backend.appendLog(change, [
      { timestamp: this.now(), user: await backend.currentUser(), action: { kind: "comment", text } },
    ]);
  },
});

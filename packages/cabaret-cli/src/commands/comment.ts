import { buildCommand } from "@stricli/core";
import { assertChangeExists, parseRefName, type RefName, UserError } from "cabaret-core";
import type { LocalContext } from "../context.js";

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
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to comment on (defaults to current)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: RefName }, text: string) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    // Logs are only ever started by `create`; appending to a missing one
    // would conjure a change out of thin air.
    assertChangeExists(change, await backend.readLog(change));
    await backend.appendLog(change, [
      { timestamp: this.now(), user: await backend.currentUser(), action: { kind: "comment", text } },
    ]);
  },
});

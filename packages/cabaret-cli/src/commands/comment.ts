import { buildCommand } from "@stricli/core";
import { currentComments, editComment, resolveCommentKey, UserError } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange, writeThrough } from "./shared.js";

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
      "Add a comment to a change. Appends one `comment` entry to the change's " +
      "log; `show` displays the comments. With `--edit`, rewrites a comment " +
      "instead: the text becomes the displayed version of the comment named.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the comment text", placeholder: "text", parse: parseCommentText }],
    },
    flags: {
      change: changeFlag("comment on"),
      edit: {
        kind: "parsed",
        parse: String,
        brief: "Comment to rewrite, by the key `show` displays",
        placeholder: "key",
        optional: true,
      } as const,
    },
  },
  async func(this: LocalContext, flags: { change?: string; edit?: string }, text: string) {
    const backend = await this.backend();
    const { change, entries } = await resolveChange(backend, flags.change);
    if (flags.edit === undefined) {
      await backend.appendLog(change, [
        { timestamp: this.now(), user: await backend.currentUser(), action: { kind: "comment", text } },
      ]);
    } else {
      await editComment(backend, this.now, change, resolveCommentKey(await currentComments(entries), flags.edit), text);
    }
    await writeThrough(this, backend, change);
  },
});

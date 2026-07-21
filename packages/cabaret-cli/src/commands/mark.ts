import { buildCommand } from "@stricli/core";
import { assertNoConflict, NotReviewingError, UserError } from "cabaret-core";
import { changeSnapshot } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange, selectFiles } from "./shared.js";

export const mark = buildCommand({
  docs: {
    brief: "Record review of files up to a revision you read",
    fullDescription:
      "Record review of files: one `review` entry per file, recording the " +
      "change's base and the tip the diff you read ended at — `review` " +
      "prints the exact command. Arguments select files the way `review` " +
      "does.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: { brief: "files or patterns to mark reviewed", placeholder: "file", parse: String },
      minimum: 1,
    },
    flags: {
      change: changeFlag("mark"),
      tip: {
        kind: "parsed",
        parse: String,
        brief: "The revision the diff you read reviewed up to, as `review` printed it",
      },
      evenThoughNotReviewing: {
        kind: "boolean",
        brief: "Record review even though the reviewing set does not include you",
        default: false,
      },
    },
  },
  async func(
    this: LocalContext,
    flags: { change?: string; tip: string; evenThoughNotReviewing: boolean },
    ...args: string[]
  ) {
    const backend = await this.backend();
    const { change } = await resolveChange(backend, flags.change);
    const snapshot = await changeSnapshot(backend, change);
    assertNoConflict(change, snapshot.conflicts);
    if (!snapshot.asked && !flags.evenThoughNotReviewing) {
      throw new NotReviewingError(change, snapshot.reviewing, snapshot.user);
    }
    if (snapshot.left.size === 0) {
      throw new UserError(`nothing is left to review in ${JSON.stringify(change)}`);
    }
    const tip = await backend.resolveCommit(flags.tip);
    const files = selectFiles(backend, [...snapshot.left.keys()], args, true, "file with review left");
    await backend.appendLog(
      change,
      files.map((file) => ({
        timestamp: this.now(),
        user: snapshot.user,
        action: { kind: "review" as const, file, base: snapshot.base, tip },
      })),
    );
  },
});

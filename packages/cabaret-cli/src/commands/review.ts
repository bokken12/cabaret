import { buildCommand } from "@stricli/core";
import {
  assertNoConflict,
  assertReviewing,
  changeBase,
  conflictedFiles,
  type RefName,
  requireBranchTip,
} from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

export const review = buildCommand({
  docs: {
    brief: "Mark files of a change as reviewed",
    fullDescription:
      "Mark files of a change as reviewed. Appends one `review` entry per file " +
      "recording the base and tip of the reviewed diff, where the base is the " +
      "last revision shared with the change's parent.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: { brief: "files to mark as reviewed", placeholder: "file", parse: String },
      minimum: 1,
    },
    flags: {
      change: changeFlag("review"),
      tip: {
        kind: "parsed",
        parse: String,
        brief: "Mark as reviewed at this tip revision (defaults to the change's tip)",
        optional: true,
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
    flags: { change?: RefName; tip?: string; evenThoughNotReviewing: boolean },
    ...rawFiles: string[]
  ) {
    const backend = await this.backend();
    const files = rawFiles.map((raw) => backend.resolveFile(raw));
    const { change, entries } = await resolveChange(backend, flags.change);
    if (!flags.evenThoughNotReviewing) {
      await assertReviewing(backend, change, entries);
    }
    const branchTip = await requireBranchTip(backend, change);
    const tip = flags.tip === undefined ? branchTip : await backend.resolveCommit(flags.tip);
    const base = await changeBase(backend, change, entries);
    // Conflicts are judged at the change's own tip whatever --tip says: while
    // markers sit in the code, fixing them — not review — is the change's
    // next step.
    assertNoConflict(change, await conflictedFiles(backend, branchTip, await backend.changedFiles(base, branchTip)));
    const user = await backend.currentUser();
    await backend.appendLog(
      change,
      files.map((file) => ({
        timestamp: this.now(),
        user,
        action: { kind: "review" as const, file, base, tip },
      })),
    );
  },
});

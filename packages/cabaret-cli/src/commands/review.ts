import { buildCommand } from "@stricli/core";
import { assertReviewing, changeBase, parseRefName, type RefName } from "cabaret-core";
import type { LocalContext } from "../context.js";

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
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to review (defaults to current)",
        optional: true,
      },
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
    const change = flags.change ?? (await backend.currentBranch());
    const entries = await backend.readLog(change);
    if (!flags.evenThoughNotReviewing) {
      await assertReviewing(backend, change, entries);
    }
    // Pin the default to the branch namespace so a same-named tag cannot
    // shadow the change's tip.
    const tip = await backend.resolveCommit(flags.tip ?? `refs/heads/${change}`);
    const base = await changeBase(backend, change, entries);
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

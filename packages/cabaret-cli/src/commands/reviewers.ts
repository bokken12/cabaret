import { buildCommand, buildRouteMap } from "@stricli/core";
import { assertChangeExists, assertNotLanded, parseRefName, type RefName, type UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { parseUser } from "./shared.js";

/** Append one reviewer entry to `change`'s log. */
async function recordReviewer(
  ctx: LocalContext,
  change: RefName | undefined,
  reviewer: UserName,
  kind: "add-reviewer" | "remove-reviewer",
): Promise<void> {
  const backend = await ctx.backend();
  const target = change ?? (await backend.currentBranch());
  const entries = await backend.readLog(target);
  assertChangeExists(target, entries);
  // A landed change is frozen: its obligations were settled when it landed.
  assertNotLanded(target, entries);
  await backend.appendLog(target, [
    { timestamp: ctx.now(), user: await backend.currentUser(), action: { kind, reviewer } },
  ]);
}

export const reviewers = buildRouteMap({
  docs: { brief: "Manage a change's reviewers" },
  routes: {
    add: buildCommand({
      docs: {
        brief: "Add a reviewer to a change",
        fullDescription:
          "Add a reviewer to a change. A reviewer owes review of the change's " +
          "whole diff, as the owner does; `show` displays the reviewers, and " +
          "`pull`/`push` sync them with the forge.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to add", placeholder: "user", parse: parseUser }],
        },
        flags: {
          change: {
            kind: "parsed",
            parse: parseRefName,
            brief: "Change to add the reviewer to (defaults to current)",
            optional: true,
          },
        },
      },
      async func(this: LocalContext, flags: { change?: RefName }, reviewer: UserName) {
        await recordReviewer(this, flags.change, reviewer, "add-reviewer");
      },
    }),
    remove: buildCommand({
      docs: { brief: "Remove a reviewer from a change" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to remove", placeholder: "user", parse: parseUser }],
        },
        flags: {
          change: {
            kind: "parsed",
            parse: parseRefName,
            brief: "Change to remove the reviewer from (defaults to current)",
            optional: true,
          },
        },
      },
      async func(this: LocalContext, flags: { change?: RefName }, reviewer: UserName) {
        await recordReviewer(this, flags.change, reviewer, "remove-reviewer");
      },
    }),
  },
});

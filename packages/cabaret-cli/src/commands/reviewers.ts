import { buildCommand, buildRouteMap } from "@stricli/core";
import type { UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, parseUser, resolveChange, writeThrough } from "./shared.js";

/** Append one reviewer entry to `change`'s log. */
async function recordReviewer(
  ctx: LocalContext,
  change: string | undefined,
  reviewer: UserName,
  kind: "add-reviewer" | "remove-reviewer",
): Promise<void> {
  const backend = await ctx.backend();
  const { change: target } = await resolveChange(backend, change);
  await backend.appendLog(target, [
    { timestamp: ctx.now(), user: await backend.currentUser(), action: { kind, reviewer } },
  ]);
  await writeThrough(ctx, backend, target);
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
          "`sync` settles them with the forge.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "user to add", placeholder: "user", parse: parseUser }],
        },
        flags: { change: changeFlag("add the reviewer to") },
      },
      async func(this: LocalContext, flags: { change?: string }, reviewer: UserName) {
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
        flags: { change: changeFlag("remove the reviewer from") },
      },
      async func(this: LocalContext, flags: { change?: string }, reviewer: UserName) {
        await recordReviewer(this, flags.change, reviewer, "remove-reviewer");
      },
    }),
  },
});

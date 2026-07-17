import { buildCommand } from "@stricli/core";
import {
  assertChangeExists,
  forgeBackend,
  type PullEvent,
  pullForge,
  pullTrackedChange,
  syncedForgeChange,
  UserError,
} from "cabaret-core";
import type { LocalContext } from "../context.js";

/** Report one thing a pull did, in the CLI's voice. */
function reportPullEvent(context: LocalContext, locator: string, event: PullEvent): void {
  if (event.kind === "aliased") {
    context.process.stdout.write(`recorded ${event.alias} as an alias\n`);
    return;
  }
  const name = `${locator}#${event.id}`;
  switch (event.kind) {
    case "imported":
      context.process.stdout.write(
        `imported ${name} as ${JSON.stringify(event.change)} with ` +
          `${event.comments} comment${event.comments === 1 ? "" : "s"}\n`,
      );
      return;
    case "skipped":
      context.process.stderr.write(`warning: skipping ${name} (${JSON.stringify(event.change)}): ${event.reason}\n`);
      return;
    case "pulled":
      if (event.landed) {
        context.process.stdout.write(`${name} was merged; recorded the land\n`);
      }
      if (event.parent !== undefined) {
        context.process.stdout.write(`${name} was retargeted; reparented onto ${JSON.stringify(event.parent)}\n`);
      }
      if (event.reviewers > 0) {
        context.process.stdout.write(
          `updated ${event.reviewers} reviewer${event.reviewers === 1 ? "" : "s"} from ${name}\n`,
        );
      }
      if (event.reviewing !== undefined) {
        context.process.stdout.write(
          `${name} was marked ${event.reviewing === "none" ? "draft" : "ready"}; reviewing ${event.reviewing}\n`,
        );
      }
      if (event.archived !== undefined) {
        context.process.stdout.write(
          `${name} was ${event.archived ? "closed; archived the change" : "reopened; unarchived the change"}\n`,
        );
      }
      context.process.stdout.write(`pulled ${event.comments} comment${event.comments === 1 ? "" : "s"} from ${name}\n`);
      return;
    case "archived":
      context.process.stdout.write(`${name} was closed; archived ${JSON.stringify(event.change)}\n`);
      return;
    case "pruned":
      context.process.stdout.write(`${name} was closed; removed unreviewed change ${JSON.stringify(event.change)}\n`);
      return;
  }
}

export const pull = buildCommand({
  docs: {
    brief: "Pull activity from the forge",
    fullDescription:
      "Pull activity from the forge: import every open forge change that is " +
      "not yet a change — owned by its author, parented on the branch it " +
      "merges into — import forge comments into change logs, and record " +
      "merged forge changes as landing their changes. Pulls every unlanded " +
      "change with a forge change; --change restricts it to one. The " +
      "account the forge credentials authenticate, and its profile emails, " +
      "are recorded as aliases of you, so their changes read as yours.",
  },
  parameters: {
    flags: {
      change: {
        kind: "parsed",
        parse: String,
        brief: "Only change to pull",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: string }) {
    const backend = forgeBackend(await this.backend());
    const forge = await this.forge();
    if (flags.change !== undefined) {
      const change = backend.parseName(flags.change);
      await backend.syncLog(change);
      const entries = await backend.readLog(change);
      assertChangeExists(change, entries);
      const user = await backend.currentUser();
      const forgeChange = await syncedForgeChange(backend, this.now, user, forge, change, entries);
      if (forgeChange === undefined) {
        throw new UserError(
          `no forge change for ${JSON.stringify(change)} on ${forge.locator}; run \`cabaret push\` first`,
        );
      }
      const pulled = await pullTrackedChange(backend, this.now, user, forge, change, entries, forgeChange);
      reportPullEvent(this, forge.locator, { kind: "pulled", id: forgeChange.id, change, ...pulled });
      return;
    }
    const { open } = await pullForge(backend, this.now, forge, (event) => reportPullEvent(this, forge.locator, event));
    this.process.stdout.write(`synced ${forge.locator}: ${open} open forge change${open === 1 ? "" : "s"}\n`);
  },
});

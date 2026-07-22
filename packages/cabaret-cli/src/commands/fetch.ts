import { buildCommand } from "@stricli/core";
import { type FetchEvent, type Forge, fetchForge, fetchLocal } from "cabaret-core";
import { NoForgeError } from "cabaret-node";
import type { LocalContext } from "../context.js";
import { settledLines } from "./shared.js";

/** Report one thing the fetch did, in the CLI's voice. */
function reportFetchEvent(context: LocalContext, locator: string, event: FetchEvent): void {
  switch (event.kind) {
    case "aliased":
      context.process.stdout.write(`recorded ${event.alias} as an alias\n`);
      return;
    case "advanced":
      context.process.stdout.write(`advanced ${JSON.stringify(event.change)}\n`);
      return;
    case "imported":
      context.process.stdout.write(
        `imported ${locator}#${event.id} as ${JSON.stringify(event.change)} with ` +
          `${event.comments} comment${event.comments === 1 ? "" : "s"}\n`,
      );
      return;
    case "skipped":
      context.process.stderr.write(
        `warning: skipping ${locator}#${event.id} (${JSON.stringify(event.change)}): ${event.reason}\n`,
      );
      return;
    case "absorbed": {
      const name = `${locator}#${event.id}`;
      if (event.landed) {
        context.process.stdout.write(`${name} was merged; recorded the land\n`);
      }
      if (event.reparented !== undefined) {
        for (const child of event.reparented.children) {
          context.process.stdout.write(
            `reparented ${JSON.stringify(child)} onto ${JSON.stringify(event.reparented.onto)}\n`,
          );
        }
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
      // A land archives the change as part of concluding it; the land line
      // already tells that story.
      if (event.archived !== undefined && !event.landed) {
        context.process.stdout.write(
          `${name} was ${event.archived ? "closed; archived the change" : "reopened; unarchived the change"}\n`,
        );
      }
      context.process.stdout.write(
        `fetched ${event.comments} comment${event.comments === 1 ? "" : "s"} from ${name}\n`,
      );
      return;
    }
    case "archived":
      context.process.stdout.write(`${locator}#${event.id} was closed; archived ${JSON.stringify(event.change)}\n`);
      return;
    case "joined":
      context.process.stdout.write(`merged origin's copy of ${JSON.stringify(event.change)}\n`);
      return;
    case "pushed":
      context.process.stdout.write(`pushed ${JSON.stringify(event.change)} to origin\n`);
      return;
    case "published": {
      for (const line of settledLines(locator, { offline: false, absorbed: undefined, published: event })) {
        context.process.stdout.write(`${line}\n`);
      }
      return;
    }
    case "pruned":
      context.process.stdout.write(
        `${locator}#${event.id} was closed; removed unreviewed change ${JSON.stringify(event.change)}\n`,
      );
      return;
  }
}

export const fetch = buildCommand({
  docs: {
    brief: "Fetch remote activity",
    fullDescription:
      "Fetch remote activity: refresh origin's copies, fast-forward " +
      "branches origin is strictly ahead of, merge every change's log with " +
      "origin's, and absorb forge activity — " +
      "import every open forge change that is not yet a change, refresh " +
      "tracked ones, record lands, and prune closed imports nobody engaged " +
      "with. The account the forge credentials authenticate, and its " +
      "profile emails, are recorded as aliases of you, so their changes " +
      "read as yours. Without a forge, the origin half still runs.",
  },
  parameters: {
    flags: {
      full: {
        kind: "boolean",
        brief: "Sweep every open forge change, not just what moved since the last fetch",
        default: false,
      },
    },
  },
  async func(this: LocalContext, flags: { readonly full: boolean }) {
    const backend = await this.backend();
    let forge: Forge | undefined;
    try {
      forge = await this.forge();
    } catch (error) {
      if (!(error instanceof NoForgeError)) {
        throw error;
      }
    }
    if (forge === undefined) {
      const { synced, advanced, joined, pushed } = await fetchLocal(backend);
      for (const change of advanced) {
        this.process.stdout.write(`advanced ${JSON.stringify(change)}\n`);
      }
      for (const change of joined) {
        this.process.stdout.write(`merged origin's copy of ${JSON.stringify(change)}\n`);
      }
      for (const change of pushed) {
        this.process.stdout.write(`pushed ${JSON.stringify(change)} to origin\n`);
      }
      this.process.stdout.write(`synced ${synced.length} change${synced.length === 1 ? "" : "s"} with origin\n`);
      return;
    }
    const locator = forge.locator;
    const { coverage, swept } = await fetchForge(
      backend,
      this.now,
      forge,
      (event) => reportFetchEvent(this, locator, event),
      { full: flags.full },
    );
    const kind = coverage === "open" ? "open" : "updated";
    this.process.stdout.write(`fetched ${locator}: ${swept} ${kind} forge change${swept === 1 ? "" : "s"}\n`);
  },
});

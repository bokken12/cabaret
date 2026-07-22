import { buildCommand } from "@stricli/core";
import { type ChangeName, type Forge, type SyncResult, syncChange } from "cabaret-core";
import { NoForgeError } from "cabaret-node";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

/** Report what a sync did, in the CLI's voice. */
function reportSync(context: LocalContext, change: ChangeName, locator: string | undefined, result: SyncResult): void {
  const out = (line: string): void => {
    context.process.stdout.write(`${line}\n`);
  };
  const s = (n: number): string => (n === 1 ? "" : "s");
  if (result.joined !== undefined) {
    const { conflicts } = result.joined;
    out(
      conflicts.length > 0
        ? `merged origin's copy of ${JSON.stringify(change)}; conflicts in ${conflicts.join(", ")} — fix the markers and amend`
        : `merged origin's copy of ${JSON.stringify(change)}`,
    );
  }
  if (result.offline) {
    out("origin unreachable; synced against the last-fetched copy — sync again online to publish");
    return;
  }
  const published = result.published;
  if (published === undefined) {
    out(`synced ${JSON.stringify(change)} with origin`);
    return;
  }
  const name = `${locator}#${published.id}`;
  const absorbed = result.absorbed;
  if (absorbed !== undefined) {
    if (absorbed.landed) {
      out(`${name} was merged; recorded the land`);
    }
    if (absorbed.parent !== undefined) {
      out(`${name} was retargeted; reparented onto ${JSON.stringify(absorbed.parent)}`);
    }
    if (absorbed.reviewers > 0) {
      out(`updated ${absorbed.reviewers} reviewer${s(absorbed.reviewers)} from ${name}`);
    }
    if (absorbed.reviewing !== undefined) {
      out(`${name} was marked ${absorbed.reviewing === "none" ? "draft" : "ready"}; reviewing ${absorbed.reviewing}`);
    }
    if (absorbed.archived !== undefined) {
      out(`${name} was ${absorbed.archived ? "closed; archived the change" : "reopened; unarchived the change"}`);
    }
    if (absorbed.comments > 0) {
      out(`fetched ${absorbed.comments} comment${s(absorbed.comments)} from ${name}`);
    }
  }
  if (published.opened) {
    out(`opened ${name}`);
  }
  if (published.reviewers > 0) {
    out(`updated ${published.reviewers} reviewer${s(published.reviewers)} on ${name}`);
  }
  if (published.draft !== undefined) {
    out(`marked ${name} ${published.draft ? "draft" : "ready for review"}`);
  }
  if (published.state !== undefined) {
    out(`${published.state === "closed" ? "closed" : "reopened"} ${name}`);
  }
  if (published.archived !== undefined) {
    out(`${name} was ${published.archived ? "closed; archived the change" : "reopened; unarchived the change"}`);
  }
  if (published.comments > 0) {
    out(`posted ${published.comments} comment${s(published.comments)} to ${name}`);
  }
  out(`synced ${JSON.stringify(change)} with ${name}`);
}

export const sync = buildCommand({
  docs: {
    brief: "Sync a change with origin and its forge",
    fullDescription:
      "Sync a change: merge origin's copy of its branch into the local one " +
      "— a conflicted merge commits its markers, to fix and amend — push " +
      "the result, reconcile its forge change (opening one if none exists, " +
      "retargeting it, settling comments, reviewers, draft and archived " +
      "state both ways), and sync its log. Offline, the merge against " +
      "origin's last-fetched copy still runs; syncing again online " +
      "finishes the exchange.",
  },
  parameters: {
    flags: { change: changeFlag("sync") },
  },
  async func(this: LocalContext, flags: { change?: string }) {
    const backend = await this.backend();
    const { change } = await resolveChange(backend, flags.change);
    let forge: Forge | undefined;
    try {
      forge = await this.forge();
    } catch (error) {
      if (!(error instanceof NoForgeError)) {
        throw error;
      }
    }
    const result = await syncChange(backend, this.now, forge, change);
    reportSync(this, change, forge?.locator, result);
  },
});

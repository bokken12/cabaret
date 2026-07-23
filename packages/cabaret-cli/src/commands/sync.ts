import { buildCommand } from "@stricli/core";
import { type ChangeName, type Forge, type SyncResult, syncChange } from "cabaret-core";
import { NoForgeError } from "cabaret-node";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange, settledLines } from "./shared.js";

/** Report what a sync did, in the CLI's voice. */
function reportSync(context: LocalContext, change: ChangeName, locator: string | undefined, result: SyncResult): void {
  const out = (line: string): void => {
    context.process.stdout.write(`${line}\n`);
  };
  if (result.joined !== undefined) {
    const { conflicts } = result.joined;
    out(
      conflicts.length > 0
        ? `merged origin's copy of ${JSON.stringify(change)}; conflicts in ${conflicts.join(", ")} — fix the markers and commit`
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
  for (const line of settledLines(locator, result)) {
    out(line);
  }
  out(`synced ${JSON.stringify(change)} with ${locator}#${published.id}`);
}

export const sync = buildCommand({
  docs: {
    brief: "Sync a change with origin and its forge",
    fullDescription:
      "Sync a change: merge origin's copy of its branch into the local one " +
      "— a conflicted merge commits its markers, to fix and commit over — push " +
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

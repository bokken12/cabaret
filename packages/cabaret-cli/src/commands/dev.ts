import { buildCommand, buildRouteMap } from "@stricli/core";
import { changeDiff, currentSelf, formatLogEntry, reviewOwed, soleUser } from "cabaret-core";
import { homePage, type ReviewNode } from "cabaret-views";
import type { LocalContext } from "../context.js";

export const dev = buildRouteMap({
  docs: { brief: "Utilities for developing Cabaret" },
  routes: {
    log: buildCommand({
      docs: { brief: "Dump a change's raw log" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            {
              brief: "change to inspect (defaults to current)",
              placeholder: "change",
              parse: String,
              optional: true,
            },
          ],
        },
      },
      async func(this: LocalContext, _flags: Record<never, never>, change?: string) {
        const backend = await this.backend();
        const entries = await backend.readLog(
          change === undefined ? await backend.currentChange() : backend.parseName(change),
        );
        this.process.stdout.write(entries.map(formatLogEntry).join(""));
      },
    }),
    "review-all": buildCommand({
      docs: {
        brief: "Mark every file owed your review",
        fullDescription:
          "Mark every file the home page asks you to review: one `review` " +
          "entry per owed file, at its change's current tip.",
      },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        const self = await currentSelf(backend);
        // Obligations are per identity, so each of one's identities marks in
        // turn — the writing identity first, then each alias only what the
        // marks before it left unsatisfied.
        const identities = [self.user, ...[...self.aliases].sort()];
        const page = await homePage(backend);
        const mark = async (nodes: readonly ReviewNode[]): Promise<void> => {
          for (const { summary, owed, children } of nodes) {
            if (owed.length > 0) {
              const diff = await changeDiff(backend, summary.change, await backend.readLog(summary.change));
              for (const identity of identities) {
                const entries = await backend.readLog(summary.change);
                const files = await reviewOwed(backend, entries, summary.owner, soleUser(identity), diff);
                if (files.length === 0) {
                  continue;
                }
                await backend.appendLog(
                  summary.change,
                  files.map((file) => ({
                    timestamp: this.now(),
                    user: identity,
                    action: { kind: "review" as const, file, base: diff.base, tip: diff.tip },
                  })),
                );
              }
              this.process.stdout.write(
                `${summary.change}: marked ${owed.length} file${owed.length === 1 ? "" : "s"}\n`,
              );
            }
            await mark(children);
          }
        };
        await mark(page.review);
        if (page.review.length === 0) {
          this.process.stdout.write("nothing owed\n");
        }
        for (const { change, message } of page.broken) {
          this.process.stderr.write(`${change}: ${message}\n`);
        }
      },
    }),
    wipe: buildCommand({
      docs: {
        brief: "Delete all review state",
        fullDescription:
          "Delete the review state this repository holds: every change's log " +
          "and the fetched copies of origin's logs. Branches and commits " +
          "stay, and origin keeps its logs, so `cab fetch` restores them. " +
          "--remote deletes origin's logs too, for every user of the " +
          "repository.",
      },
      parameters: {
        flags: {
          remote: {
            kind: "boolean",
            brief: "Also delete every log on origin (unrecoverable)",
            default: false,
          },
        },
      },
      async func(this: LocalContext, flags: { remote: boolean }) {
        const backend = await this.backend();
        const wiped = await backend.wipeReviewState();
        this.process.stdout.write(`wiped the logs of ${wiped.length} change${wiped.length === 1 ? "" : "s"}\n`);
        if (flags.remote) {
          const origin = await backend.wipeOriginLogs();
          this.process.stdout.write(
            `wiped the logs of ${origin.length} change${origin.length === 1 ? "" : "s"} on origin\n`,
          );
        }
      },
    }),
  },
});

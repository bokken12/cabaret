import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  allChanges,
  changeDiff,
  currentSelf,
  formatLogEntry,
  requireNamed,
  resolveNamed,
  reviewOwed,
  soleUser,
  UserError,
  type UserName,
} from "cabaret-core";
import { GitBackend } from "cabaret-node";
import { homePage, type ReviewNode } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { parseUser } from "./shared.js";

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
        const name = change === undefined ? await backend.currentChange() : backend.parseName(change);
        const entries = resolveNamed(await allChanges(backend), name)?.entries ?? [];
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
      parameters: {
        flags: {
          for: {
            kind: "parsed",
            parse: parseUser,
            brief: "Identity to mark as (defaults to you)",
            optional: true,
          },
        },
      },
      async func(this: LocalContext, flags: { for?: UserName }) {
        const backend = await this.backend();
        const identity = flags.for ?? (await currentSelf(backend)).user;
        const page = await homePage(backend, flags.for);
        const all = await allChanges(backend);
        let marked = false;
        const mark = async (nodes: readonly ReviewNode[]): Promise<void> => {
          for (const { summary, owed, children } of nodes) {
            if (owed.length > 0) {
              const { id } = requireNamed(all, summary.change);
              const entries = await backend.readLog(id);
              const diff = await changeDiff(backend, summary.change, entries);
              // Obligations are per identity: only demands `identity`'s own
              // review can satisfy are marked, so a file owed to an alias
              // alone stays owed.
              const files = await reviewOwed(backend, entries, summary.owner, soleUser(identity), diff);
              if (files.length > 0) {
                await backend.appendLog(
                  id,
                  files.map((file) => ({
                    timestamp: this.now(),
                    user: identity,
                    action: { kind: "review" as const, file, base: diff.base, tip: diff.tip },
                  })),
                );
                marked = true;
                this.process.stdout.write(
                  `${summary.change}: marked ${files.length} file${files.length === 1 ? "" : "s"}\n`,
                );
              }
            }
            await mark(children);
          }
        };
        await mark(page.review);
        if (!marked) {
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
    "migrate-ids": buildCommand({
      docs: {
        brief: "Move name-keyed log refs onto change ids",
        fullDescription:
          "Move logs from the name-keyed ref layout onto id-keyed refs, " +
          "locally and on origin. Run once per repository, with every " +
          "machine's cabaret updated first.",
      },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        if (!(backend instanceof GitBackend)) {
          throw new UserError("migrate-ids requires the git backend");
        }
        const migrated = await backend.migrateLogRefs(this.now);
        for (const { name, id } of migrated) {
          this.process.stdout.write(`migrated ${JSON.stringify(name)} to ${id}\n`);
        }
        this.process.stdout.write(`migrated ${migrated.length} log${migrated.length === 1 ? "" : "s"}\n`);
      },
    }),
  },
});

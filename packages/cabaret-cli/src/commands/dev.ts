import { buildCommand, buildRouteMap } from "@stricli/core";
import { formatLogEntry } from "cabaret-core";
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

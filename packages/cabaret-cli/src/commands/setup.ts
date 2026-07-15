import { buildCommand, buildRouteMap } from "@stricli/core";
import type { ConfigScope } from "cabaret-core";
import { applySetup, auditSetup, declinedScopes, type SetupAudit } from "cabaret-node";
import type { LocalContext } from "../context.js";

/** Render `audit`'s standing as a value with annotations, in `config list`'s idiom. */
function shownStanding({ rec, standing }: SetupAudit, declined: ReadonlySet<ConfigScope>): string {
  switch (standing.kind) {
    case "applied":
      return rec.value;
    case "unset":
      return `${rec.value} (unset${declined.has(rec.scope) ? ", declined" : ""})`;
    case "differs":
      return `${standing.current} (differs from ${rec.value})`;
  }
}

export const setup = buildRouteMap({
  docs: {
    brief: "Check and apply recommended git configuration",
    fullDescription:
      "Git configuration Cabaret recommends: zdiff3 conflict markers, " +
      "rerere, and fetching change logs with every git fetch. `list` shows " +
      "each recommendation's status; `apply` sets the unset ones, leaving a " +
      "key already set to another value alone.",
  },
  routes: {
    list: buildCommand({
      docs: { brief: "Show each recommendation and its status" },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        const declined = await declinedScopes(backend);
        const audits = await auditSetup(backend);
        const width = Math.max(...audits.map(({ rec }) => rec.key.length));
        for (const audit of audits) {
          this.process.stdout.write(`${audit.rec.key.padEnd(width)}  ${shownStanding(audit, declined)}\n`);
        }
      },
    }),
    apply: buildCommand({
      docs: { brief: "Apply the recommendations not yet set" },
      parameters: {},
      async func(this: LocalContext, _flags: Record<never, never>) {
        const backend = await this.backend();
        const audits = await auditSetup(backend);
        await applySetup(backend, audits);
        let acted = false;
        for (const { rec, standing } of audits) {
          if (standing.kind === "unset") {
            this.process.stdout.write(`${rec.multi ? "added" : "set"} ${rec.key} = ${rec.value}\n`);
            acted = true;
          } else if (standing.kind === "differs") {
            this.process.stdout.write(`kept ${rec.key} = ${standing.current}\n`);
            acted = true;
          }
        }
        if (!acted) {
          this.process.stdout.write("nothing to apply\n");
        }
      },
    }),
  },
});

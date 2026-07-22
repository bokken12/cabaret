import { buildCommand, buildRouteMap } from "@stricli/core";
import { currentReviewing, REVIEWING, type Reviewing, setReviewing, UserError, widenReviewing } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange, writeThrough } from "./shared.js";

function parseReviewing(raw: string): Reviewing {
  const value = REVIEWING.find((candidate) => candidate === raw);
  if (value === undefined) {
    throw new UserError(`not a reviewing set: ${JSON.stringify(raw)} (one of ${REVIEWING.join(", ")})`);
  }
  return value;
}

export const reviewing = buildRouteMap({
  docs: { brief: "Show or set who is asked to review a change" },
  routes: {
    show: buildCommand({
      docs: { brief: "Show who is asked to review a change" },
      parameters: {
        positional: { kind: "tuple", parameters: [] },
        flags: { change: changeFlag("show") },
      },
      async func(this: LocalContext, flags: { change?: string }) {
        const backend = await this.backend();
        const { entries } = await resolveChange(backend, flags.change);
        this.process.stdout.write(`${currentReviewing(entries)}\n`);
      },
    }),
    set: buildCommand({
      docs: {
        brief: "Set who is asked to review a change",
        fullDescription:
          "Set who is asked to review a change: none, the owner, the " +
          "reviewers, or everyone. The set gates what todos ask of people; " +
          "landing still requires every obligation. A change whose reviewing is " +
          "none shows on its forge as a draft.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "reviewing set to record", placeholder: "reviewing", parse: parseReviewing }],
        },
        flags: { change: changeFlag("act on") },
      },
      async func(this: LocalContext, flags: { change?: string }, value: Reviewing) {
        const backend = await this.backend();
        const { change, entries } = await resolveChange(backend, flags.change);
        await setReviewing(backend, this.now, change, entries, value);
        await writeThrough(this, backend, change);
      },
    }),
    widen: buildCommand({
      docs: {
        brief: "Widen who is asked to review a change",
        fullDescription:
          "Widen a change's reviewing set to the next level with review to do — " +
          "owner, reviewers, everyone — skipping levels whose users have already " +
          "read the whole diff.",
      },
      parameters: {
        positional: { kind: "tuple", parameters: [] },
        flags: { change: changeFlag("widen") },
      },
      async func(this: LocalContext, flags: { change?: string }) {
        const backend = await this.backend();
        const { change, entries } = await resolveChange(backend, flags.change);
        const { to } = await widenReviewing(backend, this.now, change, entries);
        this.process.stdout.write(`reviewing ${to}\n`);
        await writeThrough(this, backend, change);
      },
    }),
  },
});

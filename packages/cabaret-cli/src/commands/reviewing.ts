import { buildCommand } from "@stricli/core";
import {
  currentReviewing,
  REVIEWING,
  type RefName,
  type Reviewing,
  setReviewing,
  UserError,
  widenReviewing,
} from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

function parseReviewing(raw: string): Reviewing {
  const value = REVIEWING.find((candidate) => candidate === raw);
  if (value === undefined) {
    throw new UserError(`not a reviewing set: ${JSON.stringify(raw)} (one of ${REVIEWING.join(", ")})`);
  }
  return value;
}

export const reviewing = buildCommand({
  docs: {
    brief: "Show or set who is asked to review a change",
    fullDescription:
      "Show or set who is asked to review a change: none, the owner, the " +
      "reviewers, or everyone. The set gates what todos ask of people; " +
      "landing still requires every obligation. A change whose reviewing is " +
      "none shows on its forge as a draft.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "reviewing set to record (prints the current one when omitted)",
          placeholder: "reviewing",
          parse: parseReviewing,
          optional: true,
        },
      ],
    },
    flags: { change: changeFlag("act on") },
  },
  async func(this: LocalContext, flags: { change?: RefName }, value?: Reviewing) {
    const backend = await this.backend();
    const { change, entries } = await resolveChange(backend, flags.change);
    if (value === undefined) {
      this.process.stdout.write(`${currentReviewing(entries)}\n`);
      return;
    }
    await setReviewing(backend, this.now, change, entries, value);
  },
});

export const widen = buildCommand({
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
  async func(this: LocalContext, flags: { change?: RefName }) {
    const backend = await this.backend();
    const { change, entries } = await resolveChange(backend, flags.change);
    const { to } = await widenReviewing(backend, this.now, change, entries);
    this.process.stdout.write(`reviewing ${to}\n`);
  },
});

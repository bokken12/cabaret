import { buildCommand, buildRouteMap } from "@stricli/core";
import { currentPermanent, setPermanent, UserError } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

function parsePermanent(raw: string): boolean {
  if (raw !== "true" && raw !== "false") {
    throw new UserError(`not a boolean: ${JSON.stringify(raw)} (true or false)`);
  }
  return raw === "true";
}

export const permanent = buildRouteMap({
  docs: { brief: "Show or set whether a change is permanent" },
  routes: {
    show: buildCommand({
      docs: { brief: "Show whether a change is permanent" },
      parameters: {
        positional: { kind: "tuple", parameters: [] },
        flags: { change: changeFlag("show") },
      },
      async func(this: LocalContext, flags: { change?: string }) {
        const backend = await this.backend();
        const { entries } = await resolveChange(backend, flags.change);
        this.process.stdout.write(`${currentPermanent(entries)}\n`);
      },
    }),
    set: buildCommand({
      docs: {
        brief: "Set whether a change is permanent",
        fullDescription:
          "Set whether a change is permanent: structure — an umbrella others " +
          "stack work under, say — expected to outlive its lands rather than " +
          "archive on them. A permanent change refuses to archive until set " +
          "back to false.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "true or false", placeholder: "permanent", parse: parsePermanent }],
        },
        flags: { change: changeFlag("act on") },
      },
      async func(this: LocalContext, flags: { change?: string }, value: boolean) {
        const backend = await this.backend();
        const change = await resolveChange(backend, flags.change);
        await setPermanent(backend, this.now, change, value);
      },
    }),
  },
});

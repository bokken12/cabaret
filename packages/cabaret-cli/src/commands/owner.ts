import { buildCommand, buildRouteMap } from "@stricli/core";
import { currentOwner, transferChange, type UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, evenThoughNotOwner, parseUser, resolveChange } from "./shared.js";

export const owner = buildRouteMap({
  docs: { brief: "Show or set a change's owner" },
  routes: {
    show: buildCommand({
      docs: { brief: "Show a change's owner" },
      parameters: {
        positional: { kind: "tuple", parameters: [] },
        flags: { change: changeFlag("show") },
      },
      async func(this: LocalContext, flags: { change?: string }) {
        const backend = await this.backend();
        const { change, entries } = await resolveChange(backend, flags.change);
        this.process.stdout.write(`${currentOwner(change, entries)}\n`);
      },
    }),
    set: buildCommand({
      docs: {
        brief: "Set a change's owner",
        fullDescription: "Set a change's owner, replacing the current one. Only the owner may transfer ownership.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "the new owner", placeholder: "user", parse: parseUser }],
        },
        flags: {
          change: changeFlag("transfer"),
          evenThoughNotOwner,
        },
      },
      async func(this: LocalContext, flags: { change?: string; evenThoughNotOwner: boolean }, newOwner: UserName) {
        const backend = await this.backend();
        const change = flags.change === undefined ? await backend.currentChange() : backend.parseName(flags.change);
        await transferChange(backend, this.now, change, newOwner, flags.evenThoughNotOwner);
      },
    }),
  },
});

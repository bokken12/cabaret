import { buildCommand, buildRouteMap } from "@stricli/core";
import { currentName, renameChange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, evenThoughNotOwner, resolveChange, writeThrough } from "./shared.js";

export const name = buildRouteMap({
  docs: { brief: "Show or set a change's name" },
  routes: {
    show: buildCommand({
      docs: { brief: "Show a change's name" },
      parameters: {
        positional: { kind: "tuple", parameters: [] },
        flags: { change: changeFlag("show") },
      },
      async func(this: LocalContext, flags: { change?: string }) {
        const backend = await this.backend();
        const { id, entries } = await resolveChange(backend, flags.change);
        this.process.stdout.write(`${currentName(id, entries)}\n`);
      },
    }),
    set: buildCommand({
      docs: {
        brief: "Rename a change",
        fullDescription:
          "Rename a change. Its branch follows everywhere it lives — origin " +
          "included, an open forge change carried along — and resolution " +
          "answers to the new name from here on.",
      },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "the new name", placeholder: "name", parse: String }],
        },
        flags: {
          change: changeFlag("rename"),
          evenThoughNotOwner,
        },
      },
      async func(this: LocalContext, flags: { change?: string; evenThoughNotOwner: boolean }, raw: string) {
        const backend = await this.backend();
        const change = await resolveChange(backend, flags.change);
        await renameChange(backend, this.now, this.forge, change, backend.parseName(raw), {
          notOwner: flags.evenThoughNotOwner,
        });
        await writeThrough(this, backend, change);
      },
    }),
  },
});

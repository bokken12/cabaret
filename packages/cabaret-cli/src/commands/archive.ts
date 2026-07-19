import { buildCommand } from "@stricli/core";
import { setArchived } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

export const archive = buildCommand({
  docs: {
    brief: "Set a change aside without landing it",
    fullDescription:
      "Set a change aside without landing it: the change leaves the home " +
      "page and refuses to land, but its branch and log stay. A push closes " +
      "its forge change. `cabaret unarchive` brings it back.",
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: { change: changeFlag("archive") },
  },
  async func(this: LocalContext, flags: { change?: string }) {
    const backend = await this.backend();
    const { change, entries } = await resolveChange(backend, flags.change);
    await setArchived(backend, this.now, change, entries, true);
  },
});

export const unarchive = buildCommand({
  docs: {
    brief: "Bring an archived change back",
    fullDescription:
      "Bring an archived change back: it returns to the home page and may " +
      "land again. A push reopens its forge change.",
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: { change: changeFlag("unarchive") },
  },
  async func(this: LocalContext, flags: { change?: string }) {
    const backend = await this.backend();
    const { change, entries } = await resolveChange(backend, flags.change);
    await setArchived(backend, this.now, change, entries, false);
  },
});

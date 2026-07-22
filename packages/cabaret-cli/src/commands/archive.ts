import { buildCommand } from "@stricli/core";
import { setArchived } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange, writeThrough } from "./shared.js";

export const archive = buildCommand({
  docs: {
    brief: "Set a change aside without landing it",
    fullDescription:
      "Set a change aside without landing it: the change leaves the home " +
      "page and refuses to land, but its branch and log stay. A push closes " +
      "its forge change. `cab archive --undo` brings it back.",
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      change: changeFlag("archive"),
      undo: {
        kind: "boolean",
        brief: "Bring the change back: it may land again, and a push reopens its forge change",
        default: false,
      },
    },
  },
  async func(this: LocalContext, flags: { change?: string; undo: boolean }) {
    const backend = await this.backend();
    const change = await resolveChange(backend, flags.change);
    await setArchived(backend, this.now, change, !flags.undo);
    await writeThrough(this, backend, change);
  },
});

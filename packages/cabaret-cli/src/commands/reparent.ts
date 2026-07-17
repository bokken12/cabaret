import { buildCommand } from "@stricli/core";
import { reparentChange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { evenThoughNotOwner } from "./shared.js";

export const reparent = buildCommand({
  docs: {
    brief: "Update a change's parent",
    fullDescription:
      "Update a change's parent. This is a metadata/log change only, and does not " +
      "touch code without a subsequent `rebase`. Only the change's owner may " +
      "reparent it.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change to reparent", placeholder: "change", parse: String },
        { brief: "the new parent", placeholder: "parent", parse: String },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, change: string, parent: string) {
    const backend = await this.backend();
    await reparentChange(
      backend,
      this.now,
      backend.parseName(change),
      backend.parseName(parent),
      flags.evenThoughNotOwner,
    );
  },
});

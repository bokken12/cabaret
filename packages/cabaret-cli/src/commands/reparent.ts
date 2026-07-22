import { buildCommand } from "@stricli/core";
import { reparentChange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { evenThoughNotOwner, writeThrough } from "./shared.js";

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
    flags: {
      evenThoughNotOwner,
      evenThoughParentArchived: {
        kind: "boolean",
        brief: "Proceed even though the new parent is archived",
        default: false,
      },
      evenThoughParentDiverged: {
        kind: "boolean",
        brief: "Proceed even though the new parent's readings have diverged",
        default: false,
      },
    },
  },
  async func(
    this: LocalContext,
    flags: { evenThoughNotOwner: boolean; evenThoughParentArchived: boolean; evenThoughParentDiverged: boolean },
    change: string,
    parent: string,
  ) {
    const backend = await this.backend();
    const name = backend.parseName(change);
    await reparentChange(backend, this.now, name, backend.parseName(parent), {
      notOwner: flags.evenThoughNotOwner,
      parentArchived: flags.evenThoughParentArchived,
      parentDiverged: flags.evenThoughParentDiverged,
    });
    await writeThrough(this, backend, name);
  },
});

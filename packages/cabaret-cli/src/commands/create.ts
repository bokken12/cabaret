import { buildCommand } from "@stricli/core";
import { createChange, type UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { parseUser } from "./shared.js";

export const create = buildCommand({
  docs: {
    brief: "Create a change",
    fullDescription:
      "Create a change, initializing its log with a parent, a base, and an " +
      "owner. A change with no code yet starts at the parent's " +
      "tip; an existing branch is adopted with the last revision shared with " +
      "the parent as its base. The change must not already exist.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "name for the new change", placeholder: "change", parse: String }],
    },
    flags: {
      parent: {
        kind: "parsed",
        parse: String,
        brief: "The new change's parent (defaults to what is checked out)",
        optional: true,
      },
      owner: {
        kind: "parsed",
        parse: parseUser,
        brief: "The new change's owner (defaults to you)",
        optional: true,
      },
      evenThoughParentLanded: {
        kind: "boolean",
        brief: "Proceed even though the parent has landed",
        default: false,
      },
      evenThoughParentArchived: {
        kind: "boolean",
        brief: "Proceed even though the parent is archived",
        default: false,
      },
    },
  },
  async func(
    this: LocalContext,
    flags: { parent?: string; owner?: UserName; evenThoughParentLanded: boolean; evenThoughParentArchived: boolean },
    change: string,
  ) {
    const backend = await this.backend();
    const name = backend.parseName(change);
    const parent = flags.parent === undefined ? await backend.currentChange() : backend.parseName(flags.parent);
    await createChange(
      backend,
      this.now,
      name,
      parent,
      { parentLanded: flags.evenThoughParentLanded, parentArchived: flags.evenThoughParentArchived },
      flags.owner,
    );
  },
});

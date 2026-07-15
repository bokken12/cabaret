import { buildCommand } from "@stricli/core";
import { createChange, parseRefName, type RefName, type UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { parseUser } from "./shared.js";

export const create = buildCommand({
  docs: {
    brief: "Create a change",
    fullDescription:
      "Create a change, initializing its log with a parent, a base, and an " +
      "owner. A branch that does not exist yet is created at the parent's " +
      "tip; an existing branch is adopted with the last revision shared with " +
      "the parent as its base. The change must not already exist.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "name for the new change", placeholder: "change", parse: parseRefName }],
    },
    flags: {
      parent: {
        kind: "parsed",
        parse: parseRefName,
        brief: "The new change's parent (defaults to the current branch)",
        optional: true,
      },
      owner: {
        kind: "parsed",
        parse: parseUser,
        brief: "The new change's owner (defaults to you)",
        optional: true,
      },
    },
  },
  async func(this: LocalContext, flags: { parent?: RefName; owner?: UserName }, change: RefName) {
    const backend = await this.backend();
    await createChange(backend, this.now, change, flags.parent ?? (await backend.currentBranch()), flags.owner);
  },
});

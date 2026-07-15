import { buildCommand } from "@stricli/core";
import { parseRefName, type RefName, renameChange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { evenThoughNotOwner } from "./shared.js";

export const rename = buildCommand({
  docs: {
    brief: "Rename a change",
    fullDescription:
      "Rename a change: move its branch and its log to the new name together, " +
      "atomically. Only the change's owner may rename it.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change's old name", placeholder: "old", parse: parseRefName },
        { brief: "change's new name", placeholder: "new", parse: parseRefName },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, from: RefName, to: RefName) {
    await renameChange(await this.backend(), from, to, flags.evenThoughNotOwner);
  },
});

import { buildCommand } from "@stricli/core";
import { renameChange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { evenThoughNotOwner } from "./shared.js";

export const rename = buildCommand({
  docs: {
    brief: "Rename a change",
    fullDescription:
      "Rename a change: move its code and its log to the new name together, " +
      "atomically. Only the change's owner may rename it.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "change's old name", placeholder: "old", parse: String },
        { brief: "change's new name", placeholder: "new", parse: String },
      ],
    },
    flags: { evenThoughNotOwner },
  },
  async func(this: LocalContext, flags: { evenThoughNotOwner: boolean }, from: string, to: string) {
    const backend = await this.backend();
    await renameChange(backend, backend.parseName(from), backend.parseName(to), flags.evenThoughNotOwner);
  },
});

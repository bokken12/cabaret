import { buildCommand } from "@stricli/core";
import { gotoChange, parseRefName, type RefName, readConfig } from "cabaret-core";
import type { LocalContext } from "../context.js";

export const goto = buildCommand({
  docs: {
    brief: "Print the workspace directory of a change, materializing one if needed",
    fullDescription:
      "Print the directory of the workspace holding the change. A change " +
      "with no workspace first gets one per the `workspace-style` setting: " +
      "checked out in the current workspace (shared), or in a fresh " +
      "dedicated workspace (dedicated). Compose with cd to move there: " +
      'cd "$(cabaret goto some-change)".',
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "change to go to", placeholder: "change", parse: parseRefName }],
    },
    flags: {
      evenThoughDirty: {
        kind: "boolean",
        brief: "Check out the change here even though this workspace has uncommitted changes",
        default: false,
      },
    },
  },
  async func(this: LocalContext, flags: { evenThoughDirty: boolean }, change: RefName) {
    const backend = await this.backend();
    const result = await gotoChange(backend, await readConfig(backend), change, flags.evenThoughDirty);
    this.process.stdout.write(`${result.path}\n`);
  },
});

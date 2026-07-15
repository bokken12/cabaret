import { buildCommand } from "@stricli/core";
import { parseRefName, type RefName } from "cabaret-core";
import { showDoc, showPage } from "cabaret-views";
import type { LocalContext } from "../context.js";
import { writeDoc } from "./shared.js";

export const show = buildCommand({
  docs: { brief: "Show a change's status" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to show (defaults to current)",
          placeholder: "change",
          parse: parseRefName,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: RefName) {
    const backend = await this.backend();
    const target = change ?? (await backend.currentBranch());
    const page = await showPage(backend, await backend.currentUser(), target);
    writeDoc(this, showDoc(page));
  },
});

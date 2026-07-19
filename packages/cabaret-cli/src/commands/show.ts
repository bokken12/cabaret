import { buildCommand } from "@stricli/core";
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
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: string) {
    const backend = await this.backend();
    const target = change === undefined ? await backend.currentChange() : backend.parseName(change);
    const page = await showPage(backend, target);
    writeDoc(this, showDoc(page));
  },
});

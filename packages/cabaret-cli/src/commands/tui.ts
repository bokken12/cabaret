import { buildCommand } from "@stricli/core";
import { runTui } from "cabaret-tui";
import type { LocalContext } from "../context.js";

export const tui = buildCommand({
  docs: { brief: "Browse pages in the terminal" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to open (defaults to the home page)",
          placeholder: "change",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: string) {
    const backend = await this.backend();
    await runTui(
      backend,
      change === undefined ? { kind: "home" } : { kind: "show", change: backend.parseName(change) },
    );
  },
});

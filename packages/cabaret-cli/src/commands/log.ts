import { buildCommand } from "@stricli/core";
import { formatLogEntry } from "cabaret-core";
import type { LocalContext } from "../context.js";

export const log = buildCommand({
  docs: { brief: "Show a log of actions on a change" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to inspect (defaults to current)",
          placeholder: "change",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(this: LocalContext, _flags: Record<never, never>, change?: string) {
    const backend = await this.backend();
    const entries = await backend.readLog(
      change === undefined ? await backend.currentChange() : backend.parseName(change),
    );
    this.process.stdout.write(entries.map(formatLogEntry).join(""));
  },
});

import { buildCommand } from "@stricli/core";
import type { LocalContext } from "../context.js";

export const sync = buildCommand({
  docs: {
    brief: "Sync review state with origin",
    fullDescription:
      "Sync review state with origin: fetch every change's log, merge it " +
      "with the local log, and push the result. Only logs move; branches " +
      "sync through git or `cabaret pull`/`cabaret push`.",
  },
  parameters: {},
  async func(this: LocalContext, _flags: Record<never, never>) {
    const backend = await this.backend();
    const changes = await backend.syncLogs();
    this.process.stdout.write(`synced ${changes.length} change${changes.length === 1 ? "" : "s"} with origin\n`);
  },
});

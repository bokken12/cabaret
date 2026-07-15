import { buildCommand } from "@stricli/core";
import type { RefName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

export const forget = buildCommand({
  docs: {
    brief: "Forget files of a change, so they need review again",
    fullDescription:
      "Forget files of a change, so they need review again. Appends one " +
      "`forget` entry per file to the change's log.",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: { brief: "files to forget", placeholder: "file", parse: String },
      minimum: 1,
    },
    flags: { change: changeFlag("forget in") },
  },
  async func(this: LocalContext, flags: { change?: RefName }, ...rawFiles: string[]) {
    const backend = await this.backend();
    const files = rawFiles.map((raw) => backend.resolveFile(raw));
    const { change } = await resolveChange(backend, flags.change);
    const user = await backend.currentUser();
    await backend.appendLog(
      change,
      files.map((file) => ({
        timestamp: this.now(),
        user,
        action: { kind: "forget" as const, file },
      })),
    );
  },
});

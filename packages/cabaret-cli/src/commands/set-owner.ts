import { buildCommand } from "@stricli/core";
import { parseRefName, type RefName, transferChange, type UserName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { evenThoughNotOwner, parseUser } from "./shared.js";

export const setOwner = buildCommand({
  docs: {
    brief: "Set a change's owner",
    fullDescription:
      "Set a change's owner, replacing the current one. Only the owner may " +
      "transfer ownership; `show` displays the owner.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the new owner", placeholder: "user", parse: parseUser }],
    },
    flags: {
      change: {
        kind: "parsed",
        parse: parseRefName,
        brief: "Change to transfer (defaults to current)",
        optional: true,
      },
      evenThoughNotOwner,
    },
  },
  async func(this: LocalContext, flags: { change?: RefName; evenThoughNotOwner: boolean }, newOwner: UserName) {
    const backend = await this.backend();
    const change = flags.change ?? (await backend.currentBranch());
    await transferChange(backend, this.now, change, newOwner, flags.evenThoughNotOwner);
  },
});

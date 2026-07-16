import { buildCommand } from "@stricli/core";
import { forgeBackend, pushChange, type RefName } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { changeFlag, resolveChange } from "./shared.js";

export const push = buildCommand({
  docs: {
    brief: "Push activity to the forge",
    fullDescription:
      "Push activity to the forge: push the change's branch, open its forge " +
      "change if there is none (merging into the change's parent), retarget " +
      "it to the parent, and post the change's comments the forge lacks.",
  },
  parameters: {
    flags: { change: changeFlag("push") },
  },
  async func(this: LocalContext, flags: { change?: RefName }) {
    const backend = forgeBackend(await this.backend());
    const forge = await this.forge();
    const { change, entries } = await resolveChange(backend, flags.change);
    const pushed = await pushChange(backend, this.now, forge, change, entries);
    if (pushed.opened) {
      this.process.stdout.write(`opened ${forge.locator}#${pushed.id}\n`);
    }
    if (pushed.reviewers > 0) {
      this.process.stdout.write(
        `updated ${pushed.reviewers} reviewer${pushed.reviewers === 1 ? "" : "s"} on ${forge.locator}#${pushed.id}\n`,
      );
    }
    if (pushed.draft !== undefined) {
      this.process.stdout.write(
        `marked ${forge.locator}#${pushed.id} ${pushed.draft ? "draft" : "ready for review"}\n`,
      );
    }
    this.process.stdout.write(
      `pushed ${pushed.comments} comment${pushed.comments === 1 ? "" : "s"} to ${forge.locator}#${pushed.id}\n`,
    );
  },
});

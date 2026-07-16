import { buildCommand } from "@stricli/core";
import { type ChangeName, type LogEntry, landAsConfigured, landChain, readConfig, resolveRange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { type ChangeSpec, evenThoughNotOwner, parseChangeSpec } from "./shared.js";

/** The escape hatch for the review-obligations check on `land`. */
const evenThoughUnreviewed = {
  kind: "boolean",
  brief: "Land even though review obligations are unsatisfied",
  default: false,
} as const;

export const land = buildCommand({
  docs: {
    brief: "Land a change into its parent",
    fullDescription:
      "Land a change: write it onto its parent as a commit marked as landing " +
      "(a merge, or a squash with cabaret config land-method squash), so " +
      "the parent's reviewers are not asked to re-review the change's diff, " +
      "and record the landing in the change's log. A change tracked on a " +
      "forge lands by merging there and fetching the result; cabaret config " +
      "land-via local (or forge) picks one side " +
      "unconditionally. A change whose parent moved on lands as it stands " +
      "when it merges cleanly onto the new tip; `cabaret rebase` first when " +
      "it conflicts. Children of the landed change are reparented onto its " +
      "parent, where their code now lives. A landed change can no longer be " +
      "rebased, renamed, reparented, or transferred, though reviewing it is " +
      "still recorded. A range `ancestor..descendant` lands every change " +
      "after `ancestor` on `descendant`'s parent chain, `descendant` first, " +
      "skipping changes that already landed; when one fails, the landings " +
      "before it stand, and rerunning the range resumes.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change or ancestor..descendant range to land (defaults to current)",
          placeholder: "change",
          parse: parseChangeSpec,
          optional: true,
        },
      ],
    },
    flags: { evenThoughNotOwner, evenThoughUnreviewed },
  },
  async func(
    this: LocalContext,
    flags: { evenThoughNotOwner: boolean; evenThoughUnreviewed: boolean },
    spec?: ChangeSpec,
  ) {
    const backend = await this.backend();
    const config = await readConfig(backend);
    const landOne = async (change: ChangeName, entries: readonly LogEntry[]) => {
      const { merged, reparented } = await landAsConfigured(backend, this.now, this.forge, config, change, entries, {
        notOwner: flags.evenThoughNotOwner,
        unreviewed: flags.evenThoughUnreviewed,
      });
      if (merged !== undefined) {
        this.process.stdout.write(`merged ${merged.forge}#${merged.id}\n`);
      }
      if (reparented !== undefined) {
        for (const child of reparented.children) {
          this.process.stdout.write(`reparented ${JSON.stringify(child)} onto ${JSON.stringify(reparented.onto)}\n`);
        }
      }
    };
    if (spec === undefined || spec.kind === "one") {
      const target = spec === undefined ? await backend.currentChange() : backend.parseName(spec.change);
      await landOne(target, await backend.readLog(target));
    } else {
      const chain = await resolveRange(backend, backend.parseName(spec.ancestor), backend.parseName(spec.descendant));
      await landChain(backend, chain, landOne);
    }
  },
});

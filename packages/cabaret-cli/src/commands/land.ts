import { buildCommand } from "@stricli/core";
import {
  type Change,
  currentName,
  currentParent,
  landAsConfigured,
  landChain,
  readConfig,
  reconcileChange,
  resolveRange,
} from "cabaret-core";
import type { LocalContext } from "../context.js";
import {
  type ChangeSpec,
  evenThoughNotOwner,
  forgeIfAny,
  parseChangeSpec,
  resolveChange,
  settledLines,
} from "./shared.js";

/** The escape hatch for the review-obligations check on `land`. */
const evenThoughUnreviewed = {
  kind: "boolean",
  brief: "Land even though review obligations are unsatisfied",
  default: false,
} as const;

/** The escape hatch for the parent-obligations check on `land`. */
const evenThoughParentUnreviewed = {
  kind: "boolean",
  brief: "Land even though the parent's review obligations are unsatisfied",
  default: false,
} as const;

export const land = buildCommand({
  docs: {
    brief: "Land a change into its parent",
    fullDescription:
      "Land a change: write it onto its parent as a commit marked as landing " +
      "(a merge, or a squash with cab config land-method squash), so " +
      "the parent's reviewers are not asked to re-review the change's diff, " +
      "and record the landing in the change's log. A change tracked on a " +
      "forge lands by merging there and fetching the result; cab config " +
      "land-via local (or forge) picks one side " +
      "unconditionally. A change whose parent moved on lands as it stands " +
      "when it merges cleanly onto the new tip; `cab rebase` first when " +
      "it conflicts. Landing concludes the change: it archives, and its " +
      "children are reparented onto its parent, where their code now " +
      "lives, their forge changes retargeted to match. A permanent change " +
      "stays live instead, at the landing commit with an empty diff, ready " +
      "for its next cycle of work. A range `ancestor..descendant` lands " +
      "every change after `ancestor` on `descendant`'s parent chain, " +
      "`descendant` first, skipping archived changes; when one fails, the " +
      "landings before it stand, and rerunning the range resumes.",
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
    flags: { evenThoughNotOwner, evenThoughUnreviewed, evenThoughParentUnreviewed },
  },
  async func(
    this: LocalContext,
    flags: { evenThoughNotOwner: boolean; evenThoughUnreviewed: boolean; evenThoughParentUnreviewed: boolean },
    spec?: ChangeSpec,
  ) {
    const backend = await this.backend();
    const config = await readConfig(backend);
    const landOne = async (change: Change) => {
      // Lands write through like any command: the reconcile settles the
      // forge change — a pending retarget included — before the land reads
      // it, and the land proceeds on the settled log.
      const forge = await forgeIfAny(this);
      const settled = await reconcileChange(backend, this.now, forge, change);
      for (const line of settledLines(forge?.locator, settled)) {
        this.process.stdout.write(`${line}\n`);
      }
      const current = { ...change, entries: await backend.readLog(change.id) };
      const { merged, reparented, publication } = await landAsConfigured(
        backend,
        this.now,
        this.forge,
        config,
        current,
        {
          notOwner: flags.evenThoughNotOwner,
          unreviewed: flags.evenThoughUnreviewed,
          parentUnreviewed: flags.evenThoughParentUnreviewed,
        },
      );
      const parent = currentParent(currentName(current.id, current.entries), current.entries);
      if (merged !== undefined) {
        this.process.stdout.write(`merged ${merged.forge}#${merged.id}\n`);
      }
      if (publication === "published") {
        this.process.stdout.write(`pushed ${JSON.stringify(parent)} to origin\n`);
      } else if (publication === "origin-unreachable") {
        this.process.stderr.write(
          `warning: origin unreachable; ${JSON.stringify(parent)} keeps the land locally — push it when back online\n`,
        );
      }
      if (reparented !== undefined) {
        const retargeted = new Map(reparented.retargeted.map((entry) => [entry.change, entry]));
        for (const child of reparented.children) {
          this.process.stdout.write(`reparented ${JSON.stringify(child)} onto ${JSON.stringify(reparented.onto)}\n`);
          const forgeChange = retargeted.get(child);
          if (forgeChange !== undefined) {
            this.process.stdout.write(
              `retargeted ${forgeChange.forge}#${forgeChange.id} onto ${JSON.stringify(reparented.onto)}\n`,
            );
          }
        }
      }
    };
    if (spec === undefined || spec.kind === "one") {
      await landOne(await resolveChange(backend, spec?.change));
    } else {
      const chain = await resolveRange(backend, backend.parseName(spec.ancestor), backend.parseName(spec.descendant));
      await landChain(backend, chain, landOne);
    }
  },
});

import { buildCommand } from "@stricli/core";
import { rebaseChain, rebaseChange, resolveRange } from "cabaret-core";
import type { LocalContext } from "../context.js";
import { type ChangeSpec, evenThoughNotOwner, parseChangeSpec } from "./shared.js";

export const rebase = buildCommand({
  docs: {
    brief: "Move a change onto its parent's tip",
    fullDescription:
      "Move a change onto its parent's tip by merging the tip into the " +
      "change, then record the new base in the log. A conflicting merge is " +
      "committed with its markers in place; fix them and amend, then " +
      "continue. Only the change's owner may rebase it. A range " +
      "`ancestor..descendant` rebases every change after `ancestor` on " +
      "`descendant`'s parent chain, ancestormost first, skipping changes " +
      "that have landed; a conflict stops the range there, and rerunning it " +
      "resumes once the conflict is fixed.",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change or ancestor..descendant range to rebase (defaults to current)",
          placeholder: "change",
          parse: parseChangeSpec,
          optional: true,
        },
      ],
    },
    flags: {
      evenThoughNotOwner,
      evenThoughParentStale: {
        kind: "boolean",
        brief: "Proceed even though origin's copy of the parent has moved on",
        default: false,
      },
    },
  },
  async func(
    this: LocalContext,
    flags: { evenThoughNotOwner: boolean; evenThoughParentStale: boolean },
    spec?: ChangeSpec,
  ) {
    const backend = await this.backend();
    const overrides = { notOwner: flags.evenThoughNotOwner, staleParent: flags.evenThoughParentStale };
    if (spec === undefined || spec.kind === "one") {
      const target = spec === undefined ? await backend.currentChange() : backend.parseName(spec.change);
      await rebaseChange(backend, this.now, target, await backend.readLog(target), overrides);
      return;
    }
    const chain = await resolveRange(backend, backend.parseName(spec.ancestor), backend.parseName(spec.descendant));
    await rebaseChain(backend, this.now, chain, overrides);
  },
});

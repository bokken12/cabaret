import { buildCommand } from "@stricli/core";
import { allChanges, assertChangeExists, type ChangeName, knownChanges, resolveNamed } from "cabaret-core";
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
    let target: ChangeName;
    if (change === undefined) {
      target = await backend.currentChange();
      // The implicit form answers only for names the logs speak for: a
      // change, or a trunk acknowledged by changes' parent links. Standing
      // anywhere else keeps the nudge toward creating a change, though
      // naming the branch outright still shows it.
      if (!(await knownChanges(backend)).includes(target)) {
        assertChangeExists(target, resolveNamed(await allChanges(backend), target)?.entries ?? []);
      }
    } else {
      target = backend.parseName(change);
    }
    const page = await showPage(backend, target);
    writeDoc(this, showDoc(page));
  },
});

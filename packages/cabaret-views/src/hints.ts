import type { NextStep } from "cabaret-core";
import { type Line, type Span, span } from "./doc.js";

/**
 * Key hints a host lends its pages while its bindings are still unfamiliar:
 * the keys that trigger each next step, and the keys that list every
 * binding. A host with no keys to offer renders without hints.
 */
export interface Hints {
  /** Per next step, the keys triggering it; steps absent here render bare. */
  readonly steps: ReadonlyMap<NextStep, string>;
  /** The keys that list the current page's bindings. */
  readonly help: string;
}

/** The dimmed keys trailing a next step — `rebase (! r b)` — or nothing for a step without keys. */
export function stepHint(step: NextStep, hints: Hints | undefined): readonly Span[] {
  const keys = hints?.steps.get(step);
  return keys === undefined ? [] : [span(` (${keys})`, { style: "context" })];
}

/** The note pointing at the binding list: `? for keybindings`. */
export function hintNote(hints: Hints | undefined): string | undefined {
  return hints === undefined ? undefined : `${hints.help} for keybindings`;
}

/** The dimmed closing line pointing at the binding list, with its stand-off blank. */
export function hintFooter(hints: Hints | undefined): readonly Line[] {
  const note = hintNote(hints);
  if (note === undefined) {
    return [];
  }
  return [{ spans: [] }, { spans: [span(note, { style: "context" })] }];
}

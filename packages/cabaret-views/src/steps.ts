import type { ChangeSummary, NextStep, UserName } from "cabaret-core";
import { type ChangeAction, type Span, type Style, span } from "./doc.js";

/** The action that performs `step`, or undefined for work done by hand. */
function stepAction(step: NextStep): ChangeAction | undefined {
  switch (step) {
    case "sync":
    case "rebase":
    case "reparent":
    case "widen reviewing":
    case "land":
      return step;
    default:
      return undefined;
  }
}

/**
 * Paint for the steps where immediate action matters most: a change ready to
 * land, or one whose conflicts or unreadable policy block the work on it.
 */
export function stepStyle(step: NextStep): Style | undefined {
  switch (step) {
    case "land":
      return "ready";
    case "fix conflicts":
    case "fix obligations":
      return "blocked";
    default:
      return undefined;
  }
}

/**
 * A change's next step as a span. A step an action performs links to
 * running it; the review steps open the review they ask for — the change's
 * own, or its parent's — since reviewing starts by reading; the rest render
 * bare. Land and fix conflicts catch the eye in status paint, unless the
 * caller's own style dims the row.
 */
export function stepSpan(
  summary: Pick<ChangeSummary, "nextStep" | "change" | "parent">,
  as: UserName | undefined,
  style?: Style,
): Span {
  const { nextStep: step, change, parent } = summary;
  const action = stepAction(step);
  return span(step, {
    style: style ?? stepStyle(step),
    target:
      step === "review"
        ? { kind: "reviews", change, as }
        : step === "review in parent"
          ? { kind: "reviews", change: parent, as }
          : action !== undefined
            ? { kind: "action", change, action }
            : undefined,
  });
}

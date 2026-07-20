import type { ChangeName, NextStep, UserName } from "cabaret-core";
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
 * land, or one whose conflicts block the work stacked on it.
 */
export function stepStyle(step: NextStep): Style | undefined {
  switch (step) {
    case "land":
      return "ready";
    case "fix conflicts":
      return "blocked";
    default:
      return undefined;
  }
}

/**
 * A change's next step as a span. A step an action performs links to
 * running it; the review step opens the change's review, since reviewing
 * starts by reading; the rest render bare. Land and fix conflicts catch
 * the eye in status paint, unless the caller's own style dims the row.
 */
export function stepSpan(step: NextStep, change: ChangeName, as: UserName | undefined, style?: Style): Span {
  const action = stepAction(step);
  return span(step, {
    style: style ?? stepStyle(step),
    target:
      step === "review"
        ? { kind: "review", change, as }
        : action !== undefined
          ? { kind: "action", change, action }
          : undefined,
  });
}

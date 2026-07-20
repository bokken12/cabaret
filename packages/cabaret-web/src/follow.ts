import type { Page, Target } from "cabaret-views";

/** What following a target does in a browser with no checkout of its own. */
export type Followed =
  | { readonly kind: "page"; readonly page: Page }
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "note"; readonly text: string };

/**
 * Dispatch on a target's kind: pages and external URLs open, while targets
 * that need a working tree — a source location, a workspace, a change
 * operation — report where to go instead.
 */
export function followTarget(target: Target): Followed {
  switch (target.kind) {
    case "change":
      return { kind: "page", page: { kind: "show", change: target.change, as: target.as } };
    case "review":
      return { kind: "page", page: { kind: "review", change: target.change, as: target.as } };
    case "file":
      return { kind: "page", page: { kind: "diff", change: target.change, file: target.file, as: target.as } };
    case "location":
      return { kind: "note", text: `${target.file}:${target.line} opens from a host with a checkout` };
    case "workspace":
      return { kind: "note", text: `workspace at ${target.path}` };
    case "action":
      return { kind: "note", text: `${target.action} runs from a host with a checkout` };
    case "url":
      // Docs render logs other users wrote; only web URLs may open, never
      // script schemes.
      return /^https?:\/\//i.test(target.url)
        ? { kind: "external", url: target.url }
        : { kind: "note", text: `not a web URL: ${target.url}` };
  }
}

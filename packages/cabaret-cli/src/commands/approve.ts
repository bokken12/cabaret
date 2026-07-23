import { buildCommand } from "@stricli/core";
import type { LocalContext } from "../context.js";

/**
 * Report a command that is wired up but whose behavior is not yet implemented,
 * echoing the parsed flags and arguments so the scaffold is demonstrably live.
 */
function announce(ctx: LocalContext, path: string, values: Readonly<Record<string, unknown>>): void {
  const shown = Object.entries(values)
    .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  ctx.process.stdout.write(`cab ${path}${shown ? ` (${shown})` : ""}: not yet implemented\n`);
}

export const approve = buildCommand({
  docs: { brief: "Approve a change" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "change to approve (defaults to current)",
          placeholder: "change",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      allowEmpty: {
        kind: "boolean",
        brief: "Allow approving an empty change",
        default: false,
      },
      allowOwner: {
        kind: "boolean",
        brief: "Allow approving a change you own",
        default: false,
      },
    },
  },
  func(this: LocalContext, flags: { allowEmpty: boolean; allowOwner: boolean }, change?: string) {
    announce(this, "approve", { ...flags, change });
  },
});

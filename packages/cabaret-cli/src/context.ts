import type { CommandContext, StricliProcess } from "@stricli/core";

/**
 * Context threaded through every Cabaret command. Extend this as commands gain
 * access to a `Backend`, the current working directory, and the current user.
 */
export interface LocalContext extends CommandContext {
  readonly process: StricliProcess;
}

export function buildContext(process: NodeJS.Process): LocalContext {
  // `NodeJS.Process` is a structural superset of `StricliProcess`; the only gap
  // under exactOptionalPropertyTypes is `exitCode` admitting `undefined`. We
  // must return the real `process` by reference so Stricli's exit-code writes
  // reach the runtime.
  return { process: process as StricliProcess };
}

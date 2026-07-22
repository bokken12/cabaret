import type { CommandContext, StricliProcess } from "@stricli/core";
import { type Backend, type Forge, type TimestampMs, timestampMs } from "cabaret-core";
import { openBackend, openForge } from "cabaret-node";

/**
 * Context threaded through every Cabaret command. Extend this as commands gain
 * access to the current user and other ambient state.
 */
export interface LocalContext extends CommandContext {
  readonly process: StricliProcess;
  /** Open the `Backend` for the repository containing the working directory. */
  readonly backend: () => Promise<Backend>;
  /** Open the `Forge` for the repository's `origin` remote. */
  readonly forge: () => Promise<Forge>;
  /** The current time. */
  readonly now: () => TimestampMs;
}

export function buildContext(process: NodeJS.Process): LocalContext {
  return {
    // `NodeJS.Process` is a structural superset of `StricliProcess`; the only gap
    // under exactOptionalPropertyTypes is `exitCode` admitting `undefined`. We
    // must return the real `process` by reference so Stricli's exit-code writes
    // reach the runtime.
    process: process as StricliProcess,
    backend: () => openBackend(process.cwd()),
    forge: () => openForge(process.cwd()),
    now: () => timestampMs(Date.now()),
  };
}

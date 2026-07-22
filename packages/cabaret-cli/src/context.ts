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
  /**
   * Show `text` as a transient status line, replacing the last one;
   * `undefined` clears it. Off a terminal it shows nothing, so redirected
   * output carries only real results.
   */
  readonly progress: (text: string | undefined) => void;
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
    progress: (text) => {
      if (process.stderr.isTTY === true) {
        // \r\x1b[K returns to column 0 and erases, so each line replaces the
        // last and a clear leaves the terminal where it started.
        process.stderr.write(text === undefined ? "\r\x1b[K" : `\r\x1b[K${text}`);
      }
    },
  };
}

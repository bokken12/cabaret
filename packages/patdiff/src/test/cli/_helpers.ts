/** Helpers for translating OCaml `.t` cram-style tests of the patdiff CLI. */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as AnsiText from "../../ansi-text/ansi-text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..", "..");
const entry = path.join(repoRoot, "src", "bin", "main.ts");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

export type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

export const runCli = (
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly input?: string;
  } = {},
): RunResult => {
  const result = spawnSync(tsxBin, [entry, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
};

/** Mimic the cram test helper [visible_colors] which is just
 *  `ansi_text visualize -minimize`. */
export const visibleColors = (s: string): string => AnsiText.visualize(AnsiText.minimize(s));

export const mkTmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const writeFileIn = (dir: string, name: string, contents: string): string => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
};

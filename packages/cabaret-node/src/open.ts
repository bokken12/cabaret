import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Backend, UserError } from "cabaret-core";
import { GitBackend } from "./git.js";

/**
 * Open the backend for the repository containing `dir`. Detection walks the
 * directory tree itself for a `.git` (a directory, or a worktree's file), so
 * a missing tool fails as "install git" only in a repository, never as a
 * prompt to install something unrelated.
 */
export async function openBackend(dir: string): Promise<Backend> {
  for (let probe = resolve(dir); ; ) {
    if (existsSync(join(probe, ".git"))) {
      return GitBackend.open(dir);
    }
    const parent = dirname(probe);
    if (parent === probe) {
      throw new UserError(`not inside a git repository: ${resolve(dir)}`);
    }
    probe = parent;
  }
}

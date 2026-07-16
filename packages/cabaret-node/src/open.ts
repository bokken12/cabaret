import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Backend, UserError } from "cabaret-core";
import { GitBackend } from "./git.js";
import { HgBackend } from "./hg.js";

/**
 * Open the backend for the repository containing `dir`, by whichever
 * version-control system marks it. Detection walks the directory tree
 * itself — a `.git` (a directory, or a worktree's file) or a `.hg` — so a
 * missing tool fails as "install git" or "install hg" only in a repository
 * that actually needs it, never as a prompt to install something unrelated.
 */
export async function openBackend(dir: string): Promise<Backend> {
  for (let probe = resolve(dir); ; ) {
    if (existsSync(join(probe, ".git"))) {
      return GitBackend.open(dir);
    }
    if (existsSync(join(probe, ".hg"))) {
      return HgBackend.open(dir);
    }
    const parent = dirname(probe);
    if (parent === probe) {
      throw new UserError(`not inside a git or mercurial repository: ${resolve(dir)}`);
    }
    probe = parent;
  }
}

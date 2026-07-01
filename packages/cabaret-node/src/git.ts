import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Backend, parseRefName, type RefName } from "cabaret-core";

const execFileAsync = promisify(execFile);

/**
 * Run git in `cwd` and return its stdout. On nonzero exit the rejection
 * already names the command and carries stderr in its message.
 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/** A `Backend` that shells out to a local `git`. */
export class GitBackend implements Backend {
  private constructor(readonly root: string) {}

  /** Open the git repository containing `dir`. */
  static async open(dir: string): Promise<GitBackend> {
    const out = await git(dir, ["rev-parse", "--show-toplevel"]);
    return new GitBackend(out.trimEnd());
  }

  async currentBranch(): Promise<RefName> {
    const out = await git(this.root, ["symbolic-ref", "--short", "HEAD"]);
    return parseRefName(out.trimEnd());
  }
}

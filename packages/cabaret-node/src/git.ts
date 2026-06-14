import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Backend, type CommitHash, parseCommitHash } from "cabaret-core";

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

  async resolve(revision: string): Promise<CommitHash> {
    const out = await git(this.root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
    return parseCommitHash(out.trimEnd());
  }

  async changedFiles(
    base: CommitHash,
    tip: CommitHash,
  ): Promise<readonly string[]> {
    const out = await git(this.root, ["diff", "--name-only", "-z", base, tip]);
    return out.split("\0").filter((path) => path !== "");
  }

  readFile(commit: CommitHash, path: string): Promise<string> {
    return git(this.root, ["show", `${commit}:${path}`]);
  }
}

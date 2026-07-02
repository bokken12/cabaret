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

/**
 * Where a change's log lives: a ref mirroring the change's branch name, whose
 * tree holds the log text in a single file.
 */
function logRef(change: RefName): string {
  return `refs/cabaret/log/${change}`;
}

/** Path of the log file within a log ref's tree. */
const LOG_PATH = "log";

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

  async readLog(change: RefName): Promise<string> {
    const ref = logRef(change);
    if (!(await this.refExists(ref))) {
      return "";
    }
    // A log ref whose tree lacks the log file is malformed; let git's error
    // propagate rather than masking it as an empty log.
    return git(this.root, ["cat-file", "blob", `${ref}:${LOG_PATH}`]);
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await git(this.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch (error) {
      // With --quiet, exit code 1 means exactly "no such ref"; anything else
      // (e.g. not a repository) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return false;
      }
      throw error;
    }
  }
}

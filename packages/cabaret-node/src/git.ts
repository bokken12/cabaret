import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Backend,
  type CommitHash,
  formatLogEntry,
  type LogEntry,
  parseCommitHash,
  parseLog,
  parseRefName,
  type RefName,
  type UserName,
  userName,
} from "cabaret-core";

const execFileAsync = promisify(execFile);

/**
 * Run git in `cwd`, feed it `stdin` if given, and return its stdout. On
 * nonzero exit the rejection already names the command and carries stderr in
 * its message.
 */
async function git(cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const pending = execFileAsync("git", args, { cwd });
  if (stdin !== undefined) {
    const sink = pending.child.stdin;
    if (sink == null) {
      throw new Error("git spawned without stdin");
    }
    // Swallow EPIPE from git exiting before draining stdin; the rejection of
    // `pending` already carries the real failure.
    sink.on("error", () => {});
    sink.end(stdin);
  }
  const { stdout } = await pending;
  return stdout;
}

/**
 * Where a change's log lives: a ref mirroring the change's branch name, whose
 * tree holds the log text in a single file.
 */
function logRef(change: RefName): RefName {
  return parseRefName(`refs/cabaret/log/${change}`);
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

  async currentUser(): Promise<UserName> {
    const out = await git(this.root, ["config", "user.email"]);
    const email = out.trimEnd();
    if (email === "") {
      throw new Error("git config user.email must be nonempty");
    }
    return userName(email);
  }

  async resolveCommit(revision: string): Promise<CommitHash> {
    try {
      // --end-of-options keeps a revision that starts with `-` from being
      // parsed as a flag.
      const out = await git(this.root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ]);
      return parseCommitHash(out.trimEnd());
    } catch (error) {
      // With --quiet, exit code 1 means exactly "no such revision"; anything
      // else (e.g. not a repository) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        throw new Error(`unknown revision: ${JSON.stringify(revision)}`);
      }
      throw error;
    }
  }

  async readLog(change: RefName): Promise<readonly LogEntry[]> {
    const ref = logRef(change);
    if ((await this.commitAt(ref)) === undefined) {
      return [];
    }
    // A log ref whose tree lacks the log file is malformed; let git's error
    // propagate rather than masking it as an empty log.
    return parseLog(await git(this.root, ["cat-file", "blob", `${ref}:${LOG_PATH}`]));
  }

  async appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const ref = logRef(change);
    const old = await this.commitAt(ref);
    // Read the log pinned at `old` so the content stays consistent with the
    // compare-and-swap below even if the ref moves concurrently.
    const log = old === undefined ? "" : await git(this.root, ["cat-file", "blob", `${old}:${LOG_PATH}`]);
    if (log !== "" && !log.endsWith("\n")) {
      throw new Error(`malformed log for ${change}: missing trailing newline`);
    }
    const blob = await git(this.root, ["hash-object", "-w", "--stdin"], log + entries.map(formatLogEntry).join(""));
    const tree = await git(this.root, ["mktree"], `100644 blob ${blob.trimEnd()}\t${LOG_PATH}\n`);
    const parents = old === undefined ? [] : ["-p", old];
    const commit = await git(this.root, ["commit-tree", tree.trimEnd(), "-m", "cabaret log", ...parents]);
    // Compare-and-swap on the old tip so a concurrent append fails fast
    // instead of silently losing an entry.
    await git(this.root, ["update-ref", ref, commit.trimEnd(), old ?? ""]);
  }

  /** The commit `ref` points at, or undefined if `ref` does not exist. */
  private async commitAt(ref: RefName): Promise<CommitHash | undefined> {
    try {
      const out = await git(this.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return parseCommitHash(out.trimEnd());
    } catch (error) {
      // With --quiet, exit code 1 means exactly "no such ref"; anything else
      // (e.g. not a repository) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }
}

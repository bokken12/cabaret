import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type CommitHash,
  type FilePath,
  type ForgeSnapshot,
  formatForgeSnapshot,
  formatLogEntry,
  LAND_TRAILER,
  type LandMerge,
  type LogEntry,
  mergeLogs,
  parseCommitHash,
  parseFilePath,
  parseForgeSnapshot,
  parseLog,
  parseRefName,
  type RefName,
  UserError,
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
  // Diffs can exceed Node's default 1 MiB maxBuffer.
  const pending = execFileAsync("git", args, { cwd, maxBuffer: 1024 ** 3 });
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

/** The namespace holding every ref Cabaret writes. */
const CABARET_REF_PREFIX = "refs/cabaret/";

/**
 * Where changes' logs live: under this namespace, a ref mirroring each
 * change's branch name, whose tree holds the log text in a single file.
 */
const LOG_REF_PREFIX = `${CABARET_REF_PREFIX}log/`;

/** Where `origin`'s logs land when fetched, mirroring `LOG_REF_PREFIX`. */
const REMOTE_LOG_REF_PREFIX = `${CABARET_REF_PREFIX}remote-log/`;

function logRef(change: RefName): RefName {
  return parseRefName(`${LOG_REF_PREFIX}${change}`);
}

function remoteLogRef(change: RefName): RefName {
  return parseRefName(`${REMOTE_LOG_REF_PREFIX}${change}`);
}

/** Path of the log file within a log ref's tree. */
const LOG_PATH = "log";

/** A `Backend` that shells out to a local `git`. */
export class GitBackend implements Backend {
  private constructor(
    readonly root: string,
    /** The repository's common git dir, shared by all its worktrees. */
    private readonly gitDir: string,
  ) {}

  /** Open the git repository containing `dir`. */
  static async open(dir: string): Promise<GitBackend> {
    const [root, gitDir] = await Promise.all([
      git(dir, ["rev-parse", "--show-toplevel"]),
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    return new GitBackend(root.trimEnd(), gitDir.trimEnd());
  }

  /**
   * The snapshot lives as one JSON file under the common git dir: local like
   * the cache of the forge it is (origin already holds the truth), and shared
   * by every worktree, so a sync in any of them refreshes all.
   */
  private get snapshotPath(): string {
    return join(this.gitDir, "cabaret", "forge-snapshot.json");
  }

  async readForgeSnapshot(): Promise<ForgeSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return parseForgeSnapshot(text);
  }

  async writeForgeSnapshot(snapshot: ForgeSnapshot): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    // Write-then-rename so a concurrent read never sees a torn file.
    const temp = `${this.snapshotPath}.tmp`;
    await writeFile(temp, formatForgeSnapshot(snapshot));
    await rename(temp, this.snapshotPath);
  }

  async currentBranch(): Promise<RefName> {
    const branch = await this.checkedOutBranch();
    if (branch === undefined) {
      throw new UserError("HEAD is detached; check out a branch or name the change explicitly");
    }
    return branch;
  }

  /** The branch HEAD points at, or undefined when HEAD is detached. */
  private async checkedOutBranch(): Promise<RefName | undefined> {
    try {
      const out = await git(this.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return parseRefName(out.trimEnd());
    } catch (error) {
      // With --quiet, exit code 1 means exactly "HEAD is detached"; anything
      // else (e.g. not a repository) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }

  async currentUser(): Promise<UserName> {
    let out: string;
    try {
      out = await git(this.root, ["config", "user.email"]);
    } catch (error) {
      // Exit code 1 means exactly "unset"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        throw new UserError("git config user.email is not set; log entries need an identity");
      }
      throw error;
    }
    const email = out.trimEnd();
    if (email === "") {
      throw new UserError("git config user.email must be nonempty");
    }
    return userName(email);
  }

  async config(key: string): Promise<string | undefined> {
    try {
      const out = await git(this.root, ["config", "--get", key]);
      return out.trimEnd();
    } catch (error) {
      // Exit code 1 means exactly "unset"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
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
        throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
      }
      throw error;
    }
  }

  async pushBranch(branch: RefName): Promise<void> {
    // `origin` is pinned rather than configurable: the forge to sync with is
    // likewise derived from `origin`, so the two always name the same place.
    await git(this.root, [
      "push",
      "--quiet",
      "--force-with-lease",
      "origin",
      `refs/heads/${branch}:refs/heads/${branch}`,
    ]);
  }

  async fetchBranch(branch: RefName): Promise<void> {
    // Without a leading `+` on the refspec, git refuses a non-fast-forward
    // update, so a diverged local branch fails instead of losing work. Git
    // also refuses to fetch into a checked-out branch, so that case takes a
    // real fast-forward from FETCH_HEAD, carrying the index and working tree
    // along — and still failing on divergence.
    if ((await this.checkedOutBranch()) === branch) {
      await git(this.root, ["fetch", "--quiet", "origin", `refs/heads/${branch}`]);
      await git(this.root, ["merge", "--ff-only", "FETCH_HEAD"]);
    } else {
      await git(this.root, ["fetch", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    }
  }

  async syncLog(change: RefName): Promise<void> {
    await this.fetchLogs();
    await this.reconcileLog(change);
  }

  async syncLogs(): Promise<readonly RefName[]> {
    await this.fetchLogs();
    const names = new Set<RefName>();
    for (const prefix of [LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]) {
      const out = await git(this.root, ["for-each-ref", "--format=%(refname)", prefix]);
      for (const line of out.split("\n")) {
        if (line !== "") {
          names.add(parseRefName(line.slice(prefix.length)));
        }
      }
    }
    const changes = [...names].sort();
    for (const changeName of changes) {
      await this.reconcileLog(changeName);
    }
    return changes;
  }

  async wipeReviewState(): Promise<readonly RefName[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", CABARET_REF_PREFIX]);
    const refs = out.split("\n").filter((line) => line !== "");
    if (refs.length > 0) {
      // One transaction, so a failure partway through deletes nothing.
      await git(this.root, ["update-ref", "--stdin"], refs.map((ref) => `delete ${ref}\n`).join(""));
    }
    // The whole directory, not just the snapshot file: everything under it is
    // a local cache of the forge.
    await rm(join(this.gitDir, "cabaret"), { recursive: true, force: true });
    const names = new Set<RefName>();
    for (const prefix of [LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]) {
      for (const ref of refs) {
        if (ref.startsWith(prefix)) {
          names.add(parseRefName(ref.slice(prefix.length)));
        }
      }
    }
    return [...names].sort();
  }

  async wipeOriginLogs(): Promise<readonly RefName[]> {
    const out = await git(this.root, ["ls-remote", "origin", `${CABARET_REF_PREFIX}*`]);
    const refs = out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [, ref] = line.split("\t");
        if (ref === undefined) {
          throw new Error(`malformed ls-remote line: ${JSON.stringify(line)}`);
        }
        return ref;
      });
    if (refs.length > 0) {
      await git(this.root, ["push", "--quiet", "origin", ...refs.map((ref) => `:${ref}`)]);
    }
    return refs
      .filter((ref) => ref.startsWith(LOG_REF_PREFIX))
      .map((ref) => parseRefName(ref.slice(LOG_REF_PREFIX.length)))
      .sort();
  }

  /** Fetch every log on `origin` into the remote-log namespace. */
  private async fetchLogs(): Promise<void> {
    // Forced: log merging is by content, not ancestry, so any movement of the
    // remote's logs — even a rebuilt one — is acceptable to observe.
    await git(this.root, ["fetch", "--quiet", "origin", `+${LOG_REF_PREFIX}*:${REMOTE_LOG_REF_PREFIX}*`]);
  }

  /**
   * Bring `change`'s local log and `origin`'s to the same content: merge the
   * fetched remote log into the local one, then push anything the remote
   * lacks. A concurrent local append or remote push loses us a compare-and-
   * swap; both mean new entries to merge, so re-observe and retry, bounded so
   * a persistent failure surfaces.
   */
  private async reconcileLog(change: RefName): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const local = await this.commitAt(logRef(change));
        const remote = await this.commitAt(remoteLogRef(change));
        let tip = local;
        if (remote !== undefined && remote !== local) {
          tip =
            local === undefined || (await this.isAncestor(local, remote))
              ? remote
              : (await this.isAncestor(remote, local))
                ? local
                : await this.mergeLogCommits(local, remote);
          if (tip !== local) {
            await git(this.root, ["update-ref", logRef(change), tip, local ?? ""]);
          }
        }
        if (tip === undefined || tip === remote) {
          return;
        }
        // Not forced: the push succeeds only while the remote still points at
        // what was fetched (or an ancestor), so a concurrent push is never
        // overwritten — it fails here and merges on retry.
        await git(this.root, ["push", "--quiet", "origin", `${tip}:${logRef(change)}`]);
        await git(this.root, ["update-ref", remoteLogRef(change), tip]);
        return;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
        await this.fetchLogs();
      }
    }
  }

  /** The merge of two log commits: `mergeLogs` of their entries, atop both. */
  private async mergeLogCommits(a: CommitHash, b: CommitHash): Promise<CommitHash> {
    const [logA, logB] = await Promise.all([
      git(this.root, ["cat-file", "blob", `${a}:${LOG_PATH}`]),
      git(this.root, ["cat-file", "blob", `${b}:${LOG_PATH}`]),
    ]);
    const merged = mergeLogs(parseLog(logA), parseLog(logB)).map(formatLogEntry).join("");
    const blob = await git(this.root, ["hash-object", "-w", "--stdin"], merged);
    const tree = await git(this.root, ["mktree"], `100644 blob ${blob.trimEnd()}\t${LOG_PATH}\n`);
    const commit = await git(this.root, ["commit-tree", tree.trimEnd(), "-m", "cabaret log", "-p", a, "-p", b]);
    return parseCommitHash(commit.trimEnd());
  }

  async readFile(commit: CommitHash, file: FilePath): Promise<string | undefined> {
    // In `commit:path` syntax the path is literal, so no globbing guard is needed.
    try {
      const blob = await git(this.root, ["rev-parse", "--verify", "--quiet", `${commit}:${file}`]);
      return await git(this.root, ["cat-file", "blob", blob.trimEnd()]);
    } catch (error) {
      // With --quiet, rev-parse exits 1 exactly when the path is absent;
      // anything else (e.g. the path naming a directory, so cat-file rejects
      // its tree) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }

  async changedFiles(base: CommitHash, tip: CommitHash): Promise<readonly FilePath[]> {
    // -z delimits with NULs and disables path quoting; --no-renames keeps a
    // moved file as a delete plus an add, so each listed path exists under
    // that name on whichever side has it. Submodules are dropped: a gitlink
    // is not a file, so readFile could not serve it.
    const out = await git(this.root, [
      "diff",
      "--name-only",
      "--no-renames",
      "--ignore-submodules=all",
      "-z",
      base,
      tip,
    ]);
    return out
      .split("\0")
      .filter((path) => path !== "")
      .map(parseFilePath);
  }

  async branchTip(branch: RefName): Promise<CommitHash | undefined> {
    return this.commitAt(parseRefName(`refs/heads/${branch}`));
  }

  async originTip(branch: RefName): Promise<CommitHash | undefined> {
    return this.commitAt(parseRefName(`refs/remotes/origin/${branch}`));
  }

  async createBranch(name: RefName, commit: CommitHash): Promise<void> {
    // The empty old-value makes update-ref fail if the branch already exists.
    await git(this.root, ["update-ref", `refs/heads/${name}`, commit, ""]);
  }

  async renameChange(from: RefName, to: RefName): Promise<void> {
    const tip = await this.branchTip(from);
    if (tip === undefined) {
      throw new UserError(`branch does not exist: ${JSON.stringify(from)}`);
    }
    const log = await this.commitAt(logRef(from));
    if (log === undefined) {
      throw new Error(`change has no log: ${JSON.stringify(from)}`);
    }
    // One transaction moves the branch and the log together: `create` fails on
    // an existing target, `delete` compare-and-swaps on the tips read above,
    // and any failure moves nothing.
    const transaction =
      `create refs/heads/${to} ${tip}\n` +
      `delete refs/heads/${from} ${tip}\n` +
      `create ${logRef(to)} ${log}\n` +
      `delete ${logRef(from)} ${log}\n`;
    // Git refuses to update HEAD and delete its referent in one transaction,
    // so a checked-out `from` detaches HEAD around the rename instead — a
    // ref-only move that leaves the index and working tree in place. A crash
    // here strands a detached HEAD at the tip, never a half-renamed change.
    const checkedOut = (await this.checkedOutBranch()) === from;
    if (checkedOut) {
      await git(this.root, ["update-ref", "--no-deref", "HEAD", tip]);
    }
    try {
      // The transaction does not guard other worktrees' HEADs: deleting a
      // branch out from under one leaves it on an unborn branch that a later
      // commit would quietly recreate. With this worktree's HEAD already
      // detached, any worktree still on `from` is someone else's.
      const worktrees = await git(this.root, ["worktree", "list", "--porcelain"]);
      if (worktrees.split("\n").includes(`branch refs/heads/${from}`)) {
        throw new UserError(`branch is checked out in another worktree: ${JSON.stringify(from)}`);
      }
      await git(this.root, ["update-ref", "--stdin"], transaction);
    } catch (error) {
      if (checkedOut) {
        await git(this.root, ["symbolic-ref", "HEAD", `refs/heads/${from}`]);
      }
      throw error;
    }
    if (checkedOut) {
      await git(this.root, ["symbolic-ref", "HEAD", `refs/heads/${to}`]);
    }
  }

  async mergeBase(a: RefName, b: RefName): Promise<CommitHash> {
    // Pin to the branch namespace so a same-named tag cannot shadow either side.
    const out = await git(this.root, ["merge-base", `refs/heads/${a}`, `refs/heads/${b}`]);
    return parseCommitHash(out.trimEnd());
  }

  async isAncestor(ancestor: CommitHash, descendant: CommitHash): Promise<boolean> {
    try {
      await git(this.root, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      // Exit code 1 means exactly "not an ancestor"; anything else (e.g. a
      // commit pruned by gc) is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return false;
      }
      throw error;
    }
  }

  async rebaseOnto(change: RefName, from: CommitHash, onto: CommitHash): Promise<void> {
    // --end-of-options keeps a change name that starts with `-` from being
    // parsed as a flag; `onto` and `from` are hashes, so they need no guard.
    // TODO: a conflict surfaces as this call's raw rejection — a stack trace
    // wrapping git's output — even though it is a normal user flow; pass
    // git's own conflict report through cleanly instead.
    await git(this.root, ["rebase", "--onto", onto, from, "--end-of-options", change]);
  }

  merge(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash> {
    return this.commitLand(into, onto, tip, message, ["-p", onto, "-p", tip]);
  }

  squash(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash> {
    return this.commitLand(into, onto, tip, message, ["-p", onto]);
  }

  private async commitLand(
    into: RefName,
    onto: CommitHash,
    tip: CommitHash,
    message: string,
    parents: readonly string[],
  ): Promise<CommitHash> {
    const tree = await git(this.root, ["rev-parse", `${tip}^{tree}`]);
    const out = await git(this.root, ["commit-tree", tree.trimEnd(), "-m", message, ...parents]);
    const commit = parseCommitHash(out.trimEnd());
    // A checked-out `into` takes a real fast-forward so the index and working
    // tree follow; otherwise compare-and-swap the ref. Either way a
    // concurrent move of `into` fails fast instead of landing commits the
    // caller never validated.
    if ((await this.checkedOutBranch()) === into) {
      await git(this.root, ["merge", "--ff-only", commit]);
    } else {
      await git(this.root, ["update-ref", `refs/heads/${into}`, commit, onto]);
    }
    return commit;
  }

  async landMerges(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]> {
    // Tab-delimit the fields: %P holds space-separated parents, and the
    // trailer value (checked for presence only) is a branch name, so neither
    // can contain a tab. `unfold` keeps a folded trailer value to one line.
    const out = await git(this.root, [
      "log",
      "--first-parent",
      "--reverse",
      `--format=%H%x09%P%x09%(trailers:key=${LAND_TRAILER},valueonly,unfold,separator=%x2C)`,
      `${base}..${tip}`,
    ]);
    const merges: LandMerge[] = [];
    for (const line of out.split("\n")) {
      const [commit, parentsField, trailer] = line.split("\t");
      if (commit === undefined || commit === "" || trailer === undefined || trailer === "") {
        continue;
      }
      // A land merge's onto is its first parent; a squash land's, its sole
      // parent. Trusting the trailer on a single-parent commit does mean a
      // cherry-pick of a land commit — which copies the message verbatim —
      // is skipped too, even though its diff (conflict resolutions included)
      // may match nothing that was reviewed.
      const [onto] = (parentsField ?? "").split(" ").filter((parent) => parent !== "");
      if (onto === undefined) {
        continue;
      }
      merges.push({ commit: parseCommitHash(commit), onto: parseCommitHash(onto) });
    }
    return merges;
  }

  async listChanges(): Promise<readonly RefName[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", LOG_REF_PREFIX]);
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseRefName(line.slice(LOG_REF_PREFIX.length)));
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
    // Compare-and-swap on the old tip so a concurrent append can never be
    // silently lost. Losing the swap only means someone else appended first;
    // entries commute (union-merged, timestamp-ordered), so re-reading and
    // retrying is always sound. Bounded so a persistent failure surfaces.
    for (let attempt = 0; ; attempt++) {
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
      try {
        await git(this.root, ["update-ref", ref, commit.trimEnd(), old ?? ""]);
        return;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
      }
    }
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

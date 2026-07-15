import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type CommitHash,
  type FilePath,
  formatLogEntry,
  LAND_TRAILER,
  type LandMerge,
  type LogEntry,
  mergeLogs,
  parseCommitHash,
  parseFilePath,
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

/** A response to one object query: the resolved object, with contents when asked for. */
interface ObjectResponse {
  readonly oid: string;
  readonly type: string;
  readonly body?: Buffer;
}

/**
 * A lazily spawned, long-lived `git cat-file --batch-command` child. Object
 * queries — ref resolution, file contents — cost a pipe round trip instead of
 * a process spawn, which is what keeps per-file reads (policy probes, log
 * loads) viable at monorepo scale. Requests pipeline: each is written as it
 * arrives, and responses are consumed strictly in request order. The child is
 * unref'd whenever no request is in flight, so it never holds the process
 * open; it exits on stdin EOF when its owner does.
 */
class ObjectReader {
  private child: ReturnType<typeof spawn> | undefined;
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  /** Serializes response consumption in request order. */
  private tail: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  private failure: Error | undefined;

  constructor(private readonly cwd: string) {}

  private spawned(): ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>["stdin"]> } {
    if (this.child === undefined || this.child.exitCode !== null || this.child.killed) {
      // Consumers still draining the dead child settle against `failure` and
      // `buffer`; a respawn now would reset both under them. Requests racing
      // that drain share its failure instead.
      if (this.inflight > 0) {
        throw this.failure ?? new Error("git cat-file --batch-command is down");
      }
      this.buffer = Buffer.alloc(0);
      this.failure = undefined;
      const child = spawn("git", ["cat-file", "--batch-command"], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.wake?.();
      });
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      // A write after the child dies surfaces through `failure`, not EPIPE.
      child.stdin?.on("error", () => {});
      const fail = (cause: string) => {
        this.failure ??= new Error(
          `git cat-file --batch-command ${cause}${stderr.length > 0 ? `: ${Buffer.concat(stderr).toString().trim()}` : ""}`,
        );
        this.wake?.();
      };
      child.on("error", (error) => fail(error.message));
      child.on("close", (code) => fail(`exited with ${code}`));
      this.child = child;
      this.setRef();
    }
    if (this.child.stdin == null) {
      throw new Error("git cat-file spawned without stdin");
    }
    return this.child as ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>["stdin"]> };
  }

  /** Hold the event loop open exactly while a response is owed. */
  private setRef(): void {
    // The stdio streams are sockets at runtime, whose ref/unref the stream
    // types do not declare.
    const handles = [this.child, this.child?.stdin, this.child?.stdout, this.child?.stderr] as readonly (
      | undefined
      | null
      | { ref?: () => void; unref?: () => void }
    )[];
    for (const handle of handles) {
      if (this.inflight > 0) {
        handle?.ref?.();
      } else {
        handle?.unref?.();
      }
    }
  }

  private async pull(needed: () => number): Promise<void> {
    while (needed() > this.buffer.length) {
      if (this.failure !== undefined) {
        throw this.failure;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  private async readLine(): Promise<string> {
    let eol = -1;
    await this.pull(() => {
      eol = this.buffer.indexOf(0x0a);
      return eol === -1 ? this.buffer.length + 1 : 0;
    });
    const line = this.buffer.subarray(0, eol).toString();
    this.buffer = this.buffer.subarray(eol + 1);
    return line;
  }

  private async readBytes(count: number): Promise<Buffer> {
    await this.pull(() => count);
    const bytes = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  /**
   * Resolve `object` (any revision expression), returning undefined when git
   * reports it missing. `contents` carries the object's bytes back; `info`
   * only its identity.
   */
  request(command: "contents" | "info", object: string): Promise<ObjectResponse | undefined> {
    if (object.includes("\n")) {
      throw new Error(`object name cannot span lines: ${JSON.stringify(object)}`);
    }
    const child = this.spawned();
    this.inflight += 1;
    this.setRef();
    const result = this.tail.then(async (): Promise<ObjectResponse | undefined> => {
      const header = await this.readLine();
      if (header.endsWith(" missing")) {
        return undefined;
      }
      const [oid, type, sizeText] = header.split(" ");
      const size = Number(sizeText);
      if (oid === undefined || type === undefined || !Number.isSafeInteger(size)) {
        throw new Error(`malformed cat-file response: ${JSON.stringify(header)}`);
      }
      if (command === "info") {
        return { oid, type };
      }
      // Copied out of the rolling buffer so a long-lived body does not pin
      // the whole allocation its view would alias.
      const body = Buffer.from(await this.readBytes(size));
      await this.readBytes(1); // the newline terminating the contents
      return { oid, type, body };
    });
    child.stdin.write(`${command} ${object}\n`);
    this.tail = result
      .catch(() => {})
      .then(() => {
        this.inflight -= 1;
        this.setRef();
      });
    return result;
  }
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
  /** Serves all scalar object reads without a per-read process spawn. */
  private readonly reader: ObjectReader;

  private constructor(
    readonly root: string,
    /** The repository's common git dir, shared by all its worktrees. */
    private readonly gitDir: string,
  ) {
    this.reader = new ObjectReader(root);
  }

  /** Open the git repository containing `dir`. */
  static async open(dir: string): Promise<GitBackend> {
    const [root, gitDir] = await Promise.all([
      git(dir, ["rev-parse", "--show-toplevel"]),
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    return new GitBackend(root.trimEnd(), gitDir.trimEnd());
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

  async configAll(key: string): Promise<readonly string[]> {
    try {
      // NUL termination keeps a value containing a newline one value.
      const out = await git(this.root, ["config", "-z", "--get-all", key]);
      return out.split("\0").slice(0, -1);
    } catch (error) {
      // Exit code 1 means exactly "unset"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return [];
      }
      throw error;
    }
  }

  async resolveCommit(revision: string): Promise<CommitHash> {
    // In batch-command syntax the whole line names the object, so a revision
    // starting with `-` cannot be taken for a flag.
    const response = await this.reader.request("info", `${revision}^{commit}`);
    if (response === undefined) {
      throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
    }
    return parseCommitHash(response.oid);
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

  async fetchBranches(branches: readonly RefName[]): Promise<void> {
    if (branches.length === 0) {
      return;
    }
    // Callers pass only branches absent locally, so the checked-out and
    // diverged cases `fetchBranch` handles cannot arise. Best-effort: one
    // branch origin no longer has fails a batched fetch wholesale, so fall
    // back to fetching one by one and let callers observe what arrived via
    // `branchTip`.
    const refspecs = branches.map((branch) => `refs/heads/${branch}:refs/heads/${branch}`);
    try {
      await git(this.root, ["fetch", "--quiet", "origin", ...refspecs]);
    } catch {
      for (const refspec of refspecs) {
        try {
          await git(this.root, ["fetch", "--quiet", "origin", refspec]);
        } catch {
          // Observed by the caller as a still-missing branch.
        }
      }
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
    // The directory holds only stale caches from older versions.
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
    const response = await this.reader.request("contents", `${commit}:${file}`);
    if (response === undefined) {
      return undefined;
    }
    // A path naming a directory is a caller error, as it was when cat-file
    // rejected the tree.
    if (response.type !== "blob") {
      throw new Error(`not a file: ${JSON.stringify(file)} at ${commit.slice(0, 12)} is a ${response.type}`);
    }
    return (response.body ?? Buffer.alloc(0)).toString();
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
    // Pinning the read at the resolved tip keeps it consistent under a
    // concurrent append moving the ref.
    const tip = await this.commitAt(ref);
    if (tip === undefined) {
      return [];
    }
    const log = await this.readFile(tip, parseFilePath(LOG_PATH));
    // A log ref whose tree lacks the log file is malformed; surface it rather
    // than masking it as an empty log.
    if (log === undefined) {
      throw new Error(`log ref has no ${LOG_PATH} file: ${ref}`);
    }
    return parseLog(log);
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

  async deleteLog(change: RefName): Promise<void> {
    // One transaction for the local refs, so a failure partway deletes
    // neither; origin's copy goes second, so a push failure leaves the local
    // refs deleted and a re-run only the push to redo.
    await git(this.root, ["update-ref", "--stdin"], `delete ${logRef(change)}\ndelete ${remoteLogRef(change)}\n`);
    try {
      await git(this.root, ["push", "--quiet", "origin", `:${logRef(change)}`]);
    } catch (error) {
      // Another machine deleting the same log concurrently is not a failure.
      if (!(error instanceof Error && error.message.includes("remote ref does not exist"))) {
        throw error;
      }
    }
  }

  /** The commit `ref` points at, or undefined if `ref` does not exist. */
  private async commitAt(ref: RefName): Promise<CommitHash | undefined> {
    const response = await this.reader.request("info", `${ref}^{commit}`);
    return response === undefined ? undefined : parseCommitHash(response.oid);
  }
}

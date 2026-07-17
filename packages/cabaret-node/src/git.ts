import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type ChangeName,
  type ConfigScope,
  type FilePath,
  formatLogEntry,
  LAND_TRAILER,
  type LandMerge,
  type LogEntry,
  mergeLogs,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  parseLog,
  type Recommendation,
  type Revision,
  UserError,
  type UserName,
  userName,
  VcsUnavailableError,
  type Workspace,
} from "cabaret-core";
import { AncestryCache } from "./ancestry.js";

const execFileAsync = promisify(execFile);

/** There is no `git` to run: nothing on PATH answers to the name. */
export class GitUnavailableError extends VcsUnavailableError {
  constructor() {
    super(
      "git not found on PATH; install it from https://git-scm.com/downloads (on macOS: xcode-select --install)",
      "https://git-scm.com/downloads",
    );
  }
}

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
  try {
    const { stdout } = await pending;
    return stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new GitUnavailableError();
    }
    throw error;
  }
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

/**
 * The refspec fetching every log on `origin` into the remote-log namespace.
 * Forced: log merging is by content, not ancestry, so any movement of the
 * remote's logs — even a rebuilt one — is acceptable to observe.
 */
export const LOG_FETCH_REFSPEC = `+${LOG_REF_PREFIX}*:${REMOTE_LOG_REF_PREFIX}*`;

function logRef(change: ChangeName): ChangeName {
  return parseBranchName(`${LOG_REF_PREFIX}${change}`);
}

function remoteLogRef(change: ChangeName): ChangeName {
  return parseBranchName(`${REMOTE_LOG_REF_PREFIX}${change}`);
}

/** Path of the log file within a log ref's tree. */
const LOG_PATH = "log";

/** A `Backend` that shells out to a local `git`. */
export class GitBackend implements Backend {
  readonly vcs = "git";

  readonly parseRevision = parseCommitHash;

  readonly parseName = parseBranchName;

  /** Serves all scalar object reads without a per-read process spawn. */
  private readonly reader: ObjectReader;

  /** Answers repeated and derivable ancestry queries without a spawn. */
  private readonly ancestry = new AncestryCache();

  private constructor(
    readonly root: string,
    /** The repository's common git dir, shared by all its worktrees. */
    private readonly gitDir: string,
    /**
     * Repo-relative path of the directory the backend was opened from: "" at
     * the root, "src/" below it. Asked of git rather than computed from the
     * two absolute paths, whose spellings can disagree over symlinks.
     */
    private readonly prefix: string,
  ) {
    this.reader = new ObjectReader(root);
  }

  /** Open the git repository containing `dir`. */
  static async open(dir: string): Promise<GitBackend> {
    const [root, gitDir, prefix] = await Promise.all([
      git(dir, ["rev-parse", "--show-toplevel"]),
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(dir, ["rev-parse", "--show-prefix"]),
    ]);
    return new GitBackend(root.trimEnd(), gitDir.trimEnd(), prefix.trimEnd());
  }

  resolveFile(raw: string): FilePath {
    // Check the raw spelling too: "" would otherwise normalize into a
    // plausible-looking directory path instead of failing.
    parseFilePath(raw);
    const path = normalize(isAbsolute(raw) ? relative(this.root, raw) : join(this.prefix, raw));
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new UserError(`path is outside the repository: ${JSON.stringify(raw)}`);
    }
    return parseFilePath(path);
  }

  async currentChange(): Promise<ChangeName> {
    const branch = await this.checkedOutBranch();
    if (branch === undefined) {
      throw new UserError("HEAD is detached; check out a branch or name the change explicitly");
    }
    return branch;
  }

  /** The branch HEAD points at, or undefined when HEAD is detached. */
  private async checkedOutBranch(): Promise<ChangeName | undefined> {
    try {
      const out = await git(this.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return parseBranchName(out.trimEnd());
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

  async configAll(key: string, scope?: ConfigScope): Promise<readonly string[]> {
    try {
      // NUL termination keeps a value containing a newline one value.
      const scoped = scope === undefined ? [] : [`--${scope}`];
      const out = await git(this.root, ["config", "-z", ...scoped, "--get-all", key]);
      return out.split("\0").slice(0, -1);
    } catch (error) {
      // Exit code 1 means exactly "unset"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 1) {
        return [];
      }
      throw error;
    }
  }

  async configSet(key: string, value: string, scope: ConfigScope): Promise<void> {
    await git(this.root, ["config", `--${scope}`, key, value]);
  }

  async configAdd(key: string, value: string, scope: ConfigScope): Promise<void> {
    await git(this.root, ["config", `--${scope}`, "--add", key, value]);
  }

  async configUnset(key: string, scope: ConfigScope, value?: string): Promise<boolean> {
    const args =
      value === undefined
        ? ["config", `--${scope}`, "--unset-all", key]
        : ["config", `--${scope}`, "--unset-all", "--fixed-value", key, value];
    try {
      await git(this.root, args);
      return true;
    } catch (error) {
      // Exit code 5 means exactly "nothing matched"; anything else is a real failure.
      if ((error as { code?: unknown }).code === 5) {
        return false;
      }
      throw error;
    }
  }

  setupRecommendations(): readonly Recommendation[] {
    return [
      {
        key: "merge.conflictStyle",
        value: "zdiff3",
        scope: "global",
        multi: false,
        brief: "zdiff3 conflict markers",
      },
      {
        key: "rerere.enabled",
        value: "true",
        scope: "global",
        multi: false,
        brief: "reusing recorded conflict resolutions",
      },
      {
        key: "remote.origin.fetch",
        value: LOG_FETCH_REFSPEC,
        scope: "local",
        multi: true,
        brief: "fetching change logs with every git fetch",
        applies: async (backend) => (await backend.config("remote.origin.url")) !== undefined,
      },
      {
        key: "core.commitGraph",
        value: "true",
        scope: "global",
        multi: false,
        brief: "reading the commit-graph file to keep merge-base and ancestry queries fast",
      },
      {
        key: "fetch.writeCommitGraph",
        value: "true",
        scope: "global",
        multi: false,
        brief: "writing the commit-graph file on fetch so it stays current as history grows",
      },
    ];
  }

  async resolveCommit(expression: string): Promise<Revision> {
    // In batch-command syntax the whole line names the object, so a revision
    // starting with `-` cannot be taken for a flag.
    const response = await this.reader.request("info", `${expression}^{commit}`);
    if (response === undefined) {
      throw new UserError(`unknown revision: ${JSON.stringify(expression)}`);
    }
    return parseCommitHash(response.oid);
  }

  mergedTip(merge: Revision): Promise<Revision> {
    return this.resolveCommit(`${merge}^2`);
  }

  async push(branch: ChangeName): Promise<void> {
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

  async fetch(branch: ChangeName): Promise<void> {
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

  async fetchOrigin(): Promise<void> {
    await git(this.root, ["fetch", "--quiet", "origin"]);
  }

  async syncLog(change: ChangeName): Promise<void> {
    await this.fetchLogs();
    await this.reconcileLog(change);
  }

  async syncLogs(): Promise<readonly ChangeName[]> {
    await this.fetchLogs();
    const names = new Set<ChangeName>();
    for (const prefix of [LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]) {
      const out = await git(this.root, ["for-each-ref", "--format=%(refname)", prefix]);
      for (const line of out.split("\n")) {
        if (line !== "") {
          names.add(parseBranchName(line.slice(prefix.length)));
        }
      }
    }
    const changes = [...names].sort();
    for (const changeName of changes) {
      await this.reconcileLog(changeName);
    }
    return changes;
  }

  async wipeReviewState(): Promise<readonly ChangeName[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", CABARET_REF_PREFIX]);
    const refs = out.split("\n").filter((line) => line !== "");
    if (refs.length > 0) {
      // One transaction, so a failure partway through deletes nothing.
      await git(this.root, ["update-ref", "--stdin"], refs.map((ref) => `delete ${ref}\n`).join(""));
    }
    // The directory holds only stale caches from older versions.
    await rm(join(this.gitDir, "cabaret"), { recursive: true, force: true });
    const names = new Set<ChangeName>();
    for (const prefix of [LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]) {
      for (const ref of refs) {
        if (ref.startsWith(prefix)) {
          names.add(parseBranchName(ref.slice(prefix.length)));
        }
      }
    }
    return [...names].sort();
  }

  async wipeOriginLogs(): Promise<readonly ChangeName[]> {
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
      .map((ref) => parseBranchName(ref.slice(LOG_REF_PREFIX.length)))
      .sort();
  }

  /** Fetch every log on `origin` into the remote-log namespace. */
  private async fetchLogs(): Promise<void> {
    await git(this.root, ["fetch", "--quiet", "origin", LOG_FETCH_REFSPEC]);
  }

  /**
   * Bring `change`'s local log and `origin`'s to the same content: merge the
   * fetched remote log into the local one, then push anything the remote
   * lacks. A concurrent local append or remote push loses us a compare-and-
   * swap; both mean new entries to merge, so re-observe and retry, bounded so
   * a persistent failure surfaces.
   */
  private async reconcileLog(change: ChangeName): Promise<void> {
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
  private async mergeLogCommits(a: Revision, b: Revision): Promise<Revision> {
    const [logA, logB] = await Promise.all([
      git(this.root, ["cat-file", "blob", `${a}:${LOG_PATH}`]),
      git(this.root, ["cat-file", "blob", `${b}:${LOG_PATH}`]),
    ]);
    const merged = mergeLogs(
      parseLog(logA, parseCommitHash, parseBranchName),
      parseLog(logB, parseCommitHash, parseBranchName),
    )
      .map(formatLogEntry)
      .join("");
    const blob = await git(this.root, ["hash-object", "-w", "--stdin"], merged);
    const tree = await git(this.root, ["mktree"], `100644 blob ${blob.trimEnd()}\t${LOG_PATH}\n`);
    const commit = await git(this.root, ["commit-tree", tree.trimEnd(), "-m", "cabaret log", "-p", a, "-p", b]);
    return parseCommitHash(commit.trimEnd());
  }

  async readFile(commit: Revision, file: FilePath): Promise<string | undefined> {
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

  async changedFiles(base: Revision, tip: Revision): Promise<readonly FilePath[]> {
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

  async tip(branch: ChangeName): Promise<Revision | undefined> {
    return this.commitAt(parseBranchName(`refs/heads/${branch}`));
  }

  async originTip(branch: ChangeName): Promise<Revision | undefined> {
    return this.commitAt(parseBranchName(`refs/remotes/origin/${branch}`));
  }

  async create(name: ChangeName, commit: Revision): Promise<void> {
    // The empty old-value makes update-ref fail if the branch already exists.
    await git(this.root, ["update-ref", `refs/heads/${name}`, commit, ""]);
  }

  async workspaces(): Promise<readonly Workspace[]> {
    const out = await git(this.root, ["worktree", "list", "--porcelain"]);
    // One attribute-line block per working tree, blank-line separated, the
    // primary one first.
    const listed = out
      .trimEnd()
      .split("\n\n")
      .flatMap((block, index) => {
        const lines = block.split("\n");
        const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (path === undefined || lines.includes("bare")) {
          return [];
        }
        // A prunable working tree's directory is gone; it is not a workspace.
        if (lines.some((line) => line.startsWith("prunable"))) {
          return [];
        }
        const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
        const change = ref === undefined ? undefined : parseBranchName(ref.replace(/^refs\/heads\//, ""));
        return [{ path, change, primary: index === 0 }];
      });
    return Promise.all(
      listed.map(async ({ path, change, primary }) => ({
        path,
        change,
        primary,
        dirty: (await git(path, ["status", "--porcelain"])) !== "",
      })),
    );
  }

  async addWorkspace(path: string, change: ChangeName): Promise<void> {
    await git(this.root, ["worktree", "add", "--quiet", "--end-of-options", path, change]);
  }

  async removeWorkspace(path: string, force: boolean): Promise<void> {
    await git(this.root, ["worktree", "remove", ...(force ? ["--force"] : []), "--end-of-options", path]);
  }

  async checkout(branch: ChangeName): Promise<void> {
    await git(this.root, ["switch", "--quiet", "--end-of-options", branch]);
  }

  async rename(from: ChangeName, to: ChangeName): Promise<void> {
    const tip = await this.tip(from);
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

  mergeBase(a: Revision, b: Revision): Promise<Revision> {
    return this.ancestry.mergeBase(a, b, async () => {
      const out = await git(this.root, ["merge-base", a, b]);
      return parseCommitHash(out.trimEnd());
    });
  }

  async hasRevision(revision: Revision): Promise<boolean> {
    return (await this.reader.request("info", `${revision}^{commit}`)) !== undefined;
  }

  isAncestor(ancestor: Revision, descendant: Revision): Promise<boolean> {
    return this.ancestry.isAncestor(ancestor, descendant, async () => {
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
    });
  }

  merge(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision> {
    return this.commitLand(into, base, onto, tip, message, ["-p", onto, "-p", tip]);
  }

  squash(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision> {
    return this.commitLand(into, base, onto, tip, message, ["-p", onto]);
  }

  private async commitLand(
    into: ChangeName,
    base: Revision,
    onto: Revision,
    tip: Revision,
    message: string,
    parents: readonly string[],
  ): Promise<Revision> {
    let tree: string;
    if (onto === base) {
      tree = (await git(this.root, ["rev-parse", `${tip}^{tree}`])).trimEnd();
    } else {
      const merged = await this.mergeTrees(base, tip, onto);
      if (merged.conflicts.length > 0) {
        throw new Error(`landing ${tip} onto ${onto} conflicts in ${merged.conflicts.join(", ")}`);
      }
      tree = merged.tree;
    }
    const out = await git(this.root, ["commit-tree", tree, "-m", message, ...parents]);
    const commit = parseCommitHash(out.trimEnd());
    await this.advanceBranch(into, commit, onto);
    return commit;
  }

  /**
   * Advance `branch` from `expected` to descendant `commit`. A checked-out
   * `branch` takes a real fast-forward so the index and working tree follow;
   * otherwise compare-and-swap the ref. Either way a concurrent move of
   * `branch` fails fast instead of publishing commits the caller never
   * validated.
   */
  private async advanceBranch(branch: ChangeName, commit: Revision, expected: Revision): Promise<void> {
    if ((await this.checkedOutBranch()) === branch) {
      await git(this.root, ["merge", "--ff-only", commit]);
    } else {
      await git(this.root, ["update-ref", `refs/heads/${branch}`, commit, expected]);
    }
  }

  async mergeOnto(change: ChangeName, base: Revision, onto: Revision, message: string): Promise<readonly FilePath[]> {
    const tip = await this.resolveCommit(`refs/heads/${change}`);
    if (await this.isAncestor(tip, onto)) {
      await this.advanceBranch(change, onto, tip);
      return [];
    }
    const { tree, conflicts } = await this.mergeTrees(base, tip, onto);
    const commit = await git(this.root, ["commit-tree", tree, "-m", message, "-p", tip, "-p", onto]);
    await this.advanceBranch(change, parseCommitHash(commit.trimEnd()), tip);
    return conflicts;
  }

  async mergeConflicts(base: Revision, tip: Revision, onto: Revision): Promise<readonly FilePath[]> {
    return (await this.mergeTrees(base, tip, onto)).conflicts;
  }

  /** Content-merge `tip` and `onto` against `base`: the merged tree — markers in place on a conflict — and the conflicted paths. */
  private async mergeTrees(
    base: Revision,
    tip: Revision,
    onto: Revision,
  ): Promise<{ tree: string; conflicts: readonly FilePath[] }> {
    let out: string;
    try {
      out = await git(this.root, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        `--merge-base=${base}`,
        "--end-of-options",
        tip,
        onto,
      ]);
    } catch (error) {
      // Exit code 1 means exactly "the contents conflict"; the tree is still
      // written — markers in place — with the conflicted paths listed after
      // it. Anything else is a real failure.
      if ((error as { code?: unknown }).code !== 1) {
        throw error;
      }
      out = (error as { stdout: string }).stdout;
    }
    const [tree, ...conflicted] = out.trimEnd().split("\n");
    if (tree === undefined || tree === "") {
      throw new Error(`merge-tree wrote no tree merging ${tip} and ${onto}`);
    }
    return { tree, conflicts: conflicted.map(parseFilePath) };
  }

  async landMerges(base: Revision, tip: Revision): Promise<readonly LandMerge[]> {
    // Tab-delimit the fields: %P holds space-separated parents, and the
    // trailer value is a branch name, so neither can contain a tab. `unfold`
    // keeps a folded trailer value to one line.
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
      merges.push({ change: parseBranchName(trailer), commit: parseCommitHash(commit), onto: parseCommitHash(onto) });
    }
    return merges;
  }

  async listChanges(): Promise<readonly ChangeName[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", LOG_REF_PREFIX]);
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseBranchName(line.slice(LOG_REF_PREFIX.length)));
  }

  async readLog(change: ChangeName): Promise<readonly LogEntry[]> {
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
    return parseLog(log, parseCommitHash, parseBranchName);
  }

  async appendLog(change: ChangeName, entries: readonly LogEntry[]): Promise<void> {
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

  async deleteLog(change: ChangeName): Promise<void> {
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
  private async commitAt(ref: ChangeName): Promise<Revision | undefined> {
    const response = await this.reader.request("info", `${ref}^{commit}`);
    return response === undefined ? undefined : parseCommitHash(response.oid);
  }
}

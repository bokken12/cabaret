import { execFile, spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  type Backend,
  type ChainMerge,
  type ChangedFile,
  type ChangeId,
  type ChangeName,
  type ConfigScope,
  currentName,
  type FilePath,
  formatLogEntry,
  LAND_TRAILER,
  type LogEntry,
  mergeLogs,
  parseBranchName,
  parseChangeId,
  parseCommitHash,
  parseFilePath,
  parseLog,
  type Recommendation,
  type Revision,
  type TimestampMs,
  timestampMs,
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

/**
 * A ref update losing its compare-and-swap to a concurrent process: the ref
 * "is at" the winner's value where git "expected" the one it first read. The
 * losing update aborts atomically, touching nothing.
 */
const REF_RACE = /cannot lock ref '[^']+': is at [0-9a-f]+ but expected [0-9a-f]+/;

/**
 * Run a fetch, given as full git arguments, retrying when it loses a ref
 * update race to a concurrent fetch of the same refs. A rerun recomputes
 * every update from the winner's value, so retrying is always sound — and
 * usually a no-op, the winner having installed the same values. Bounded so
 * sustained contention still surfaces.
 */
async function fetchRetryingRaces(root: string, args: readonly string[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await git(root, args);
      return;
    } catch (error) {
      if (attempt >= 2 || !REF_RACE.test((error as Error).message)) {
        throw error;
      }
    }
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
 * Where changes' logs live: under this namespace, a ref per change id,
 * whose tree holds the log text in a single file.
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


/** The id a log ref is keyed by; a pre-id ref names the reset that clears it. */
function logRefId(ref: string, prefix: string): ChangeId {
  const suffix = ref.slice(prefix.length);
  try {
    return parseChangeId(suffix);
  } catch {
    throw new UserError(`log ref predates change ids: ${ref}; run \`cab dev wipe --remote\` to reset review state`);
  }
}

function logRef(change: ChangeId): string {
  return `${LOG_REF_PREFIX}${change}`;
}

function remoteLogRef(change: ChangeId): string {
  return `${REMOTE_LOG_REF_PREFIX}${change}`;
}

/** Path of the log file within a log ref's tree. */
const LOG_PATH = "log";

/**
 * Where the forge sweep record lives: a blob of how far origin's logs have
 * absorbed the forge. Its copies join by max; the fetch is forced, and the
 * push leases on the fetched value, skipping when a racer advanced first.
 */
const FORGE_REF = `${CABARET_REF_PREFIX}forge/sweep`;
const REMOTE_FORGE_REF = `${CABARET_REF_PREFIX}remote-forge/sweep`;
// Wildcarded so a fetch finding no record yet succeeds; an exact refspec fails.
export const FORGE_FETCH_REFSPEC = `+${CABARET_REF_PREFIX}forge/*:${CABARET_REF_PREFIX}remote-forge/*`;

/** A `Backend` that shells out to a local `git`. */
export class GitBackend implements Backend {
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
    /** This workspace's own git dir — the common one in the primary worktree. */
    private readonly worktreeGitDir: string,
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
    // One spawn answers all four queries, a line each in argument order.
    const out = await git(dir, [
      "rev-parse",
      "--show-toplevel",
      "--path-format=absolute",
      "--git-common-dir",
      "--absolute-git-dir",
      "--show-prefix",
    ]);
    const [root, gitDir, worktreeGitDir, prefix] = out.split("\n");
    if (root === undefined || gitDir === undefined || worktreeGitDir === undefined || prefix === undefined) {
      throw new Error(`rev-parse answered ${JSON.stringify(out)}`);
    }
    return new GitBackend(root, gitDir, worktreeGitDir, prefix);
  }

  resolveFile(raw: string): FilePath {
    // Check the raw spelling too: "" would otherwise normalize into a
    // plausible-looking directory path instead of failing.
    parseFilePath(raw);
    const path = normalize(isAbsolute(raw) ? relative(this.root, raw) : join(this.prefix, raw));
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new UserError(`path is outside the repository: ${JSON.stringify(raw)}`);
    }
    // Tab completion leaves a trailing separator on a directory.
    return parseFilePath(path.endsWith(sep) ? path.slice(0, -1) : path);
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

  /**
   * The worktree directory holding each checked-out branch, this workspace's
   * included. Moving a held branch's ref must go through its home — plumbing
   * like `update-ref` bypasses git's one-worktree-per-branch protections and
   * would strand the home's index and working tree on the old commit.
   */
  private async branchHomes(): Promise<Map<ChangeName, string>> {
    const out = await git(this.root, ["worktree", "list", "--porcelain"]);
    const homes = new Map<ChangeName, string>();
    for (const block of out.trimEnd().split("\n\n")) {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const ref = lines.find((line) => line.startsWith("branch refs/heads/"));
      if (path !== undefined && ref !== undefined) {
        homes.set(parseBranchName(ref.slice("branch refs/heads/".length)), path);
      }
    }
    return homes;
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

  mergedOnto(merge: Revision): Promise<Revision> {
    return this.resolveCommit(`${merge}^1`);
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
    // also refuses to fetch into a branch any worktree has checked out, so
    // that case fetches origin's reading into its remote-tracking ref and
    // fast-forwards onto that in the branch's home worktree, carrying its
    // index and working tree along — and still failing on divergence.
    // Merging FETCH_HEAD instead would race: it is one file shared by every
    // fetch in the worktree, and a concurrent log fetch rewrites it to name
    // an unrelated-history log commit as the merge candidate.
    const home = (await this.branchHomes()).get(branch);
    if (home === undefined) {
      await fetchRetryingRaces(this.root, ["fetch", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    } else {
      await fetchRetryingRaces(this.root, [
        "fetch",
        "--quiet",
        "origin",
        `refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      await git(home, ["merge", "--ff-only", `refs/remotes/origin/${branch}`]);
    }
  }

  async fetchOrigin(): Promise<void> {
    // One fetch brings branches and logs alike. The log refspec goes in as
    // config because a command-line refspec would replace the configured
    // ones; `-c` adds a value to the multi-valued key instead.
    await fetchRetryingRaces(this.root, [
      "-c",
      `remote.origin.fetch=${LOG_FETCH_REFSPEC}`,
      "-c",
      `remote.origin.fetch=${FORGE_FETCH_REFSPEC}`,
      "fetch",
      "--quiet",
      "origin",
    ]);
  }

  async originFetched(): Promise<TimestampMs | undefined> {
    // Git rewrites this workspace's FETCH_HEAD on every fetch — whoever ran
    // it — so its mtime dates the last one, except that a failed fetch
    // truncates the file empty: only a ref-bearing file dates a success.
    // Fetches in other worktrees go unseen; the reading only understates.
    const file = join(this.worktreeGitDir, "FETCH_HEAD");
    try {
      const { mtimeMs } = await stat(file);
      // mtimes carry fractional milliseconds; a timestamp is whole ones.
      return (await readFile(file, "utf8")) === "" ? undefined : timestampMs(Math.round(mtimeMs));
    } catch (error) {
      // ENOENT means exactly "never fetched"; anything else is a real failure.
      if ((error as { code?: unknown }).code !== "ENOENT") {
        throw error;
      }
      return undefined;
    }
  }

  async advanceBranches(): Promise<readonly ChangeName[]> {
    const out = await git(this.root, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
      "refs/remotes/origin/",
    ]);
    const heads = new Map<ChangeName, Revision>();
    const origins = new Map<ChangeName, Revision>();
    for (const line of out.split("\n")) {
      if (line === "") {
        continue;
      }
      const space = line.indexOf(" ");
      const ref = line.slice(0, space);
      const oid = parseCommitHash(line.slice(space + 1));
      if (ref.startsWith("refs/heads/")) {
        heads.set(parseBranchName(ref.slice("refs/heads/".length)), oid);
      } else if (ref !== "refs/remotes/origin/HEAD") {
        origins.set(parseBranchName(ref.slice("refs/remotes/origin/".length)), oid);
      }
    }
    // Homes from the worktree list rather than `workspaces()`, whose
    // dirtiness reading costs a status scan per worktree — too heavy for a
    // background cadence; only the worktrees of branches origin is strictly
    // ahead of get one below.
    const homes = await this.branchHomes();
    const advanced: ChangeName[] = [];
    for (const [branch, tip] of heads) {
      const origin = origins.get(branch);
      if (origin === undefined || origin === tip) {
        continue;
      }
      if (!(await this.isAncestor(tip, origin))) {
        continue;
      }
      const home = homes.get(branch);
      if (home === undefined) {
        // CAS on the tip read above: a branch moved concurrently stays put.
        try {
          await git(this.root, ["update-ref", `refs/heads/${branch}`, origin, tip]);
        } catch {
          continue;
        }
      } else {
        // A worktree holds the branch: a real fast-forward carries its index
        // and working tree along, so only a clean worktree still on the
        // branch moves — a dirty one keeps its line of work in place. One
        // status call reads both; anything it can't say (a pruned worktree's
        // directory is gone) leaves the branch put too.
        try {
          const status = await git(home, ["status", "--porcelain=v2", "--branch"]);
          const lines = status.split("\n").filter((line) => line !== "");
          if (!lines.includes(`# branch.head ${branch}`) || lines.some((line) => !line.startsWith("# "))) {
            continue;
          }
          await git(home, ["merge", "--ff-only", origin]);
        } catch {
          continue;
        }
      }
      advanced.push(branch);
    }
    return advanced.sort();
  }

  async joinBranches(changes: readonly ChangeName[]): Promise<readonly ChangeName[]> {
    const homes = await this.branchHomes();
    const joined: ChangeName[] = [];
    for (const branch of changes) {
      const tip = await this.tip(branch);
      const origin = await this.originTip(branch);
      if (tip === undefined || origin === undefined || tip === origin) {
        continue;
      }
      if ((await this.isAncestor(tip, origin)) || (await this.isAncestor(origin, tip))) {
        continue;
      }
      // The probe merges trees without touching any worktree; a conflicted
      // pair is sync's business, and there is nothing to retry until a
      // reading moves.
      let tree: string;
      try {
        tree = (await git(this.root, ["merge-tree", "--write-tree", tip, origin])).trim();
      } catch {
        continue;
      }
      const message = `Merge origin's '${branch}' into ${branch}`;
      const home = homes.get(branch);
      if (home === undefined) {
        const commit = (await git(this.root, ["commit-tree", tree, "-p", tip, "-p", origin, "-m", message])).trim();
        // CAS on the tip read above: a branch moved concurrently stays put.
        try {
          await git(this.root, ["update-ref", `refs/heads/${branch}`, commit, tip]);
        } catch {
          continue;
        }
      } else {
        // A worktree holds the branch: the join carries its index and
        // working tree along, so only a clean worktree still on the branch
        // moves — a dirty one keeps its line of work in place.
        try {
          const status = await git(home, ["status", "--porcelain=v2", "--branch"]);
          const lines = status.split("\n").filter((line) => line !== "");
          if (!lines.includes(`# branch.head ${branch}`) || lines.some((line) => !line.startsWith("# "))) {
            continue;
          }
          await git(home, ["merge", "--no-ff", "-m", message, origin]);
        } catch {
          continue;
        }
      }
      joined.push(branch);
    }
    return joined.sort();
  }

  async syncLog(change: ChangeId): Promise<void> {
    await this.publishLogs([change]);
  }

  async syncLogs(): Promise<readonly ChangeId[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]);
    const ids = new Set<ChangeId>();
    for (const line of out.split("\n")) {
      if (line === "") {
        continue;
      }
      const prefix = line.startsWith(LOG_REF_PREFIX) ? LOG_REF_PREFIX : REMOTE_LOG_REF_PREFIX;
      ids.add(logRefId(line, prefix));
    }
    const changes = [...ids].sort();
    await this.publishLogs(changes);
    return changes;
  }

  async forgeSweepState(): Promise<string | undefined> {
    try {
      return await git(this.root, ["cat-file", "blob", REMOTE_FORGE_REF]);
    } catch {
      return undefined;
    }
  }

  async publishForgeSweepState(content: string): Promise<void> {
    const blob = (await git(this.root, ["hash-object", "-w", "--stdin"], content)).trim();
    await git(this.root, ["update-ref", FORGE_REF, blob]);
    let expected: string;
    try {
      expected = (await git(this.root, ["rev-parse", "--verify", REMOTE_FORGE_REF])).trim();
    } catch {
      // Never fetched: the lease demands the ref not exist yet.
      expected = "";
    }
    // Advance-or-skip: the lease rejects the push when someone advanced the
    // record since this fetch read it, and that advance serves in this one's
    // stead — the record never regresses. `--porcelain` reports the
    // rejection on stdout whatever the exit code; any other failure surfaces.
    try {
      await git(this.root, [
        "push",
        "--quiet",
        "--porcelain",
        `--force-with-lease=${FORGE_REF}:${expected}`,
        "origin",
        `${FORGE_REF}:${FORGE_REF}`,
      ]);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout === undefined || !stdout.split("\n").some((line) => line.startsWith("!"))) {
        throw error;
      }
    }
  }

  async wipeReviewState(): Promise<number> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", CABARET_REF_PREFIX]);
    const refs = out.split("\n").filter((line) => line !== "");
    if (refs.length > 0) {
      // One transaction, so a failure partway through deletes nothing.
      await git(this.root, ["update-ref", "--stdin"], refs.map((ref) => `delete ${ref}\n`).join(""));
    }
    // The directory holds only stale caches from older versions.
    await rm(join(this.gitDir, "cabaret"), { recursive: true, force: true });
    // Counted whatever the ref layout: a wipe clearing pre-id refs is the
    // remedy the fetch error names, and it should say what it cleared.
    const wiped = new Set<string>();
    for (const prefix of [LOG_REF_PREFIX, REMOTE_LOG_REF_PREFIX]) {
      for (const ref of refs) {
        if (ref.startsWith(prefix)) {
          wiped.add(ref.slice(prefix.length));
        }
      }
    }
    return wiped.size;
  }

  async wipeOriginLogs(): Promise<number> {
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
    return refs.filter((ref) => ref.startsWith(LOG_REF_PREFIX)).length;
  }

  /** Fetch every log on `origin` into the remote-log namespace. */
  private async fetchLogs(): Promise<void> {
    await fetchRetryingRaces(this.root, ["fetch", "--quiet", "origin", LOG_FETCH_REFSPEC]);
  }

  /**
   * Merge `change`'s fetched remote log into its local one, short of
   * publishing: a concurrent local append losing the local compare-and-swap
   * means new entries to merge, so re-observe and retry, bounded so a
   * persistent failure surfaces. Returns the tip `change`'s log should be
   * published at, or undefined when it already matches `origin`'s copy.
   */
  private async settleLog(change: ChangeId): Promise<Revision | undefined> {
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
        return tip === remote ? undefined : tip;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
        await this.fetchLogs();
      }
    }
  }

  /**
   * Push every pending log's settled tip to `origin` in one round trip, not
   * forced: a ref `origin` moved since it was settled is left unpushed,
   * reported back so the caller can re-settle and retry just that one.
   * `--porcelain` reports each ref's outcome on one line regardless of the
   * command's overall exit code, which is nonzero whenever any ref failed.
   */
  private async pushLogs(pending: readonly { change: ChangeId; tip: Revision }[]): Promise<readonly ChangeId[]> {
    const byRef = new Map(pending.map(({ change }) => [logRef(change), change]));
    let out: string;
    try {
      out = await git(this.root, [
        "push",
        "--quiet",
        "--porcelain",
        "origin",
        ...pending.map(({ change, tip }) => `${tip}:${logRef(change)}`),
      ]);
    } catch (error) {
      // Only a push that reached the remote reports per-ref outcomes; an
      // empty porcelain is a transport failure, not a rejection.
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout === undefined || stdout === "") {
        throw error;
      }
      out = stdout;
    }
    const rejected: ChangeId[] = [];
    for (const line of out.split("\n")) {
      const [flag, refspec] = line.split("\t");
      if (flag !== "!") {
        continue;
      }
      const to = refspec?.split(":")[1];
      const change = to === undefined ? undefined : byRef.get(to);
      if (change !== undefined) {
        rejected.push(change);
      }
    }
    const succeeded = pending.filter(({ change }) => !rejected.includes(change));
    if (succeeded.length > 0) {
      await git(
        this.root,
        ["update-ref", "--stdin"],
        succeeded.map(({ change, tip }) => `update ${remoteLogRef(change)} ${tip}\n`).join(""),
      );
    }
    return rejected;
  }

  /**
   * Bring every one of `changes`' logs to the same content as `origin`: settle
   * each locally, then publish every pending tip in one push. A ref `origin`
   * moved since it was settled comes back from `pushLogs` rejected; retried
   * against a fresh fetch, bounded so a persistent failure surfaces.
   */
  private async publishLogs(changes: readonly ChangeId[]): Promise<void> {
    let pending = changes;
    for (let attempt = 0; pending.length > 0; attempt++) {
      // Each change's log settles independently, so settling the batch
      // concurrently costs one round trip's latency, not `pending.length`'s.
      const withTips = await Promise.all(
        pending.map(async (change) => ({ change, tip: await this.settleLog(change) })),
      );
      const settled = withTips.filter((entry): entry is { change: ChangeId; tip: Revision } => entry.tip !== undefined);
      if (settled.length === 0) {
        return;
      }
      const rejected = await this.pushLogs(settled);
      if (rejected.length === 0) {
        return;
      }
      if (attempt >= 2) {
        throw new Error(`could not publish logs for: ${rejected.join(", ")}`);
      }
      await this.fetchLogs();
      pending = rejected;
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

  async changedFiles(base: Revision, tip: Revision): Promise<readonly ChangedFile[]> {
    // -z delimits with NULs and disables path quoting. --find-renames pairs
    // a moved file's two sides into one entry — an unchanged move by hash
    // alone, an edited one by content similarity — and --find-copies does
    // the same for a file copied from one modified in the same diff; sources
    // elsewhere in the tree go unrecognized, as scanning them all
    // (--find-copies-harder) costs too much in a large repository.
    // Submodules are dropped: a gitlink is not a file, so readFile could not
    // serve it.
    const out = await git(this.root, [
      "diff",
      "--name-status",
      "--find-renames",
      "--find-copies",
      "--ignore-submodules=all",
      "-z",
      base,
      tip,
    ]);
    // Each record is a status token, then one path — or two for a rename or
    // copy, source before destination. The trailing NUL leaves one empty
    // token at the end.
    const tokens = out.split("\0");
    const files: ChangedFile[] = [];
    for (let i = 0; ; ) {
      const status = tokens[i];
      if (status === undefined || status === "") {
        break;
      }
      const path = tokens[i + 1];
      if (path === undefined) {
        throw new Error(`diff status ${JSON.stringify(status)} names no path`);
      }
      if (/^[ADMT]$/.test(status)) {
        files.push({ path: parseFilePath(path), source: undefined });
        i += 2;
      } else if (/^[RC]\d+$/.test(status)) {
        const to = tokens[i + 2];
        if (to === undefined) {
          throw new Error(
            `${status.startsWith("R") ? "rename" : "copy"} of ${JSON.stringify(path)} names no destination`,
          );
        }
        files.push({
          path: parseFilePath(to),
          source: { path: parseFilePath(path), copied: status.startsWith("C") },
        });
        i += 3;
      } else {
        throw new Error(`unexpected diff status ${JSON.stringify(status)} for ${JSON.stringify(path)}`);
      }
    }
    return files;
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

  async advance(change: ChangeName, to: Revision): Promise<void> {
    const tip = await this.resolveCommit(`refs/heads/${change}`);
    if (tip === to) {
      return;
    }
    if (!(await this.isAncestor(tip, to))) {
      throw new Error(`cannot advance ${JSON.stringify(change)}: ${to} does not descend from its tip ${tip}`);
    }
    await this.advanceBranch(change, to, tip);
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

  async commit(message: string, paths: readonly FilePath[]): Promise<void> {
    // The index is not a user surface: unstaging first means commit stages
    // from the worktree alone, so a selection narrows correctly even when
    // something was staged by hand. `:(literal)` keeps a path with glob
    // characters naming just itself.
    await git(this.root, ["reset", "--quiet"]);
    await git(this.root, [
      "add",
      "--all",
      ...(paths.length === 0 ? [] : ["--", ...paths.map((path) => `:(literal)${path}`)]),
    ]);
    // `diff --cached --quiet` exits 1 exactly when something is staged; any
    // other failure is real.
    let staged = false;
    try {
      await git(this.root, ["diff", "--cached", "--quiet"]);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) {
        throw error;
      }
      staged = true;
    }
    if (!staged) {
      throw new UserError("nothing to commit");
    }
    await git(this.root, ["commit", "--quiet", "--message", message]);
  }

  async editedFiles(): Promise<readonly FilePath[]> {
    // -z delimits with NULs and disables path quoting; a rename or copy entry
    // carries its source as one extra NUL-separated field. Submodules are
    // dropped to match `changedFiles`.
    const out = await git(this.root, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    const fields = out.split("\0");
    const files: FilePath[] = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field === undefined || field === "") {
        continue;
      }
      files.push(parseFilePath(field.slice(3)));
      if (/[RC]/.test(field.slice(0, 2))) {
        i += 1;
        const source = fields[i];
        if (source === undefined || source === "") {
          throw new Error(`status entry ${JSON.stringify(field)} names no source`);
        }
        files.push(parseFilePath(source));
      }
    }
    return files;
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
   * Advance `branch` from `expected` to descendant `commit`. A `branch` some
   * worktree has checked out — this workspace's or a sibling's — takes a real
   * fast-forward run in that worktree, so its index and working tree follow
   * (uncommitted edits the move would overwrite fail it); otherwise
   * compare-and-swap the ref. Either way a concurrent move of `branch` fails
   * fast instead of publishing commits the caller never validated.
   */
  private async advanceBranch(branch: ChangeName, commit: Revision, expected: Revision): Promise<void> {
    const home = (await this.branchHomes()).get(branch);
    if (home === undefined) {
      await git(this.root, ["update-ref", `refs/heads/${branch}`, commit, expected]);
    } else {
      await git(home, ["merge", "--ff-only", commit]);
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

  // Tab-delimit the fields: %P holds space-separated parents, and the
  // trailer value is a branch name, so neither can contain a tab. `unfold`
  // keeps a folded trailer value to one line.
  private static readonly CHAIN_LOG_FORMAT =
    `--format=%H%x09%P%x09%(trailers:key=${LAND_TRAILER},valueonly,unfold,separator=%x2C)`;

  /** The parent hashes of a `CHAIN_LOG_FORMAT` line. */
  private static lineParents(line: string): readonly string[] {
    return (line.split("\t")[1] ?? "").split(" ").filter((parent) => parent !== "");
  }

  /** The chain merges among `CHAIN_LOG_FORMAT` lines, in line order. */
  private static parseChainLines(lines: readonly string[]): ChainMerge[] {
    const merges: ChainMerge[] = [];
    for (const line of lines) {
      const [commit, , trailer] = line.split("\t");
      if (commit === undefined || commit === "") {
        continue;
      }
      // A land merge's onto is its first parent; a squash land's, its sole
      // parent. The trailer only names what landed — review answers to the
      // entries the land wrote, so a cherry-pick copying the message claims
      // nothing.
      const [onto, merged] = GitBackend.lineParents(line);
      const landed = trailer === undefined || trailer === "" ? undefined : parseBranchName(trailer);
      if (onto === undefined || (merged === undefined && landed === undefined)) {
        continue;
      }
      merges.push({
        commit: parseCommitHash(commit),
        onto: parseCommitHash(onto),
        merged: merged === undefined ? undefined : parseCommitHash(merged),
        landed,
      });
    }
    return merges;
  }

  async chainMerges(
    base: Revision | undefined,
    tip: Revision,
    scan: number,
  ): Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined; readonly more: boolean }> {
    // One commit past the scan tells whether the chain continues; git lists
    // newest first, so the surveyed window is the lines before it, reversed.
    const out = await git(this.root, [
      "log",
      "--first-parent",
      "-n",
      String(scan + 1),
      GitBackend.CHAIN_LOG_FORMAT,
      base === undefined ? tip : `${base}..${tip}`,
    ]);
    const lines = out.split("\n").filter((line) => line !== "");
    const surveyed = lines.slice(0, scan).reverse();
    const [rootHash] = surveyed[0] === undefined ? [] : GitBackend.lineParents(surveyed[0]);
    return {
      merges: GitBackend.parseChainLines(surveyed),
      root: rootHash === undefined ? undefined : parseCommitHash(rootHash),
      more: lines.length > scan,
    };
  }

  async listChanges(): Promise<readonly ChangeId[]> {
    const out = await git(this.root, ["for-each-ref", "--format=%(refname)", LOG_REF_PREFIX]);
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => logRefId(line, LOG_REF_PREFIX));
  }

  async readLog(change: ChangeId): Promise<readonly LogEntry[]> {
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

  async appendLog(change: ChangeId, entries: readonly LogEntry[]): Promise<void> {
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

  async deleteLog(change: ChangeId): Promise<void> {
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
  private async commitAt(ref: string): Promise<Revision | undefined> {
    const response = await this.reader.request("info", `${ref}^{commit}`);
    return response === undefined ? undefined : parseCommitHash(response.oid);
  }
}

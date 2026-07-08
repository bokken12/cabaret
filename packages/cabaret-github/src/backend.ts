import {
  type Backend,
  type CommitHash,
  type FilePath,
  type ForgeSnapshot,
  formatLogEntry,
  LAND_TRAILER,
  type LandMerge,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseLog,
  parseRefName,
  type RefName,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { z } from "zod";
import { type GitHubClient, type GitHubRepo, isStatus } from "./client.js";

/**
 * Where changes' logs live: under this namespace, a ref mirroring each
 * change's branch name, whose tree holds the log text in a single file.
 */
const LOG_REF_PREFIX = "refs/cabaret/log/";

/** Path of the log file within a log ref's tree. */
const LOG_PATH = "log";

const RefSchema = z.object({
  object: z.object({ type: z.string(), sha: z.string().transform(parseCommitHash) }),
});

const CommitSchema = z.object({
  sha: z.string().transform(parseCommitHash),
  message: z.string(),
  tree: z.object({ sha: z.string() }),
  parents: z.array(z.object({ sha: z.string().transform(parseCommitHash) })),
});

const CompareSchema = z.object({
  status: z.enum(["identical", "ahead", "behind", "diverged"]),
  merge_base_commit: z.object({ sha: z.string().transform(parseCommitHash) }),
});

const CompareCommitsSchema = z.object({
  total_commits: z.number(),
  commits: z.array(
    z.object({
      sha: z.string().transform(parseCommitHash),
      commit: z.object({ message: z.string() }),
      parents: z.array(z.object({ sha: z.string().transform(parseCommitHash) })),
    }),
  ),
});

const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() })),
});

/** Whether the message's final paragraph carries the `Cabaret-Landed` trailer. */
function hasLandTrailer(message: string): boolean {
  const paragraphs = message.replace(/\n+$/, "").split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  return last.split("\n").some((line) => line.startsWith(`${LAND_TRAILER}:`));
}

// Revision suffixes resolveCommit understands: `^` or `^N` selects a parent,
// `~N` walks N first parents. `changeTip`'s `<hash>^2` is the load-bearing case.
const REVISION_SUFFIX = /(?:\^(\d*)|~(\d+))$/;

/**
 * A `Backend` for a github.com repository, speaking the API directly — no
 * clone, no working tree. Refs, commits, and blobs go through the Git
 * database API, so review state reads and writes work from a browser, which
 * is what `cabaret-web` requires.
 *
 * There is no second repository: this backend talks to `origin` itself, so
 * the sync operations have nothing to reconcile and succeed as no-ops, while
 * the operations that need a working tree (`currentBranch`, `rebaseOnto`,
 * `renameChange`) fail with a `UserError` naming a local checkout as the way
 * out.
 */
export class GitHubBackend implements Backend {
  private user: Promise<UserName> | undefined;
  // Git objects and the facts derived from them are immutable once a hash is
  // known, so hash-keyed queries cache for the backend's lifetime: reviewing
  // walks the same history from several pages, and each fact should cost one
  // request per session, not one per page. Only mutable reads — refs and the
  // logs behind them — always go to the API.
  private readonly commits = new Map<CommitHash, Promise<z.infer<typeof CommitSchema>>>();
  private readonly contents = new Map<string, Promise<string | undefined>>();
  private readonly ancestry = new Map<string, Promise<boolean>>();
  private readonly diffs = new Map<string, Promise<readonly FilePath[]>>();
  private readonly lands = new Map<string, Promise<readonly LandMerge[]>>();
  // Per-change append batching: the open batch still accepting entries, and
  // the settled-or-not tail of the append chain. `running` never rejects —
  // failures surface through each batch's own `done`.
  private readonly waiting = new Map<RefName, { entries: LogEntry[]; done: Promise<void> }>();
  private readonly running = new Map<RefName, Promise<void>>();
  // Held in memory only: this backend lives in a browser session with no
  // filesystem, and its host is online by construction, so it re-syncs the
  // snapshot rather than persisting one.
  private snapshot: ForgeSnapshot | undefined;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: GitHubRepo,
  ) {}

  async readForgeSnapshot(): Promise<ForgeSnapshot | undefined> {
    return this.snapshot;
  }

  async writeForgeSnapshot(snapshot: ForgeSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  /** The cached promise for `key`, computing and remembering it on the first ask; a rejection is not cached. */
  private cached<K, V>(cache: Map<K, Promise<V>>, key: K, compute: () => Promise<V>): Promise<V> {
    let value = cache.get(key);
    if (value === undefined) {
      value = compute().catch((error: unknown) => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, value);
    }
    return value;
  }

  async currentBranch(): Promise<RefName> {
    throw new UserError("no branch is checked out over the GitHub API; name the change explicitly");
  }

  async config(): Promise<string | undefined> {
    // There is no git config over the API; every setting takes its default.
    return undefined;
  }

  currentUser(): Promise<UserName> {
    // The token's account, by its public profile email when it shows one,
    // else GitHub's noreply convention — the same identity mapping the forge
    // uses for request authors, so one person is one user either way. Only a
    // success is cached: a transient failure must not poison a long-lived
    // session.
    this.user ??= this.client
      .request("GET /user")
      .then(({ data }) => {
        const { login, email } = z.object({ login: z.string(), email: z.string().nullable() }).parse(data);
        return email === null || email === "" ? userName(`${login}@users.noreply.github.com`) : userName(email);
      })
      .catch((error: unknown) => {
        this.user = undefined;
        throw error;
      });
    return this.user;
  }

  async resolveCommit(revision: string): Promise<CommitHash> {
    const parents: number[] = [];
    let base = revision;
    for (let match = REVISION_SUFFIX.exec(base); match !== null; match = REVISION_SUFFIX.exec(base)) {
      const [suffix, caret, tilde] = match;
      parents.unshift(...(caret !== undefined ? [Number(caret === "" ? 1 : caret)] : Array(Number(tilde)).fill(1)));
      base = base.slice(0, -suffix.length);
    }
    let sha = await this.resolveBase(base, revision);
    for (const n of parents) {
      const commit = await this.commit(sha);
      const parent = commit.parents[n - 1];
      if (parent === undefined) {
        throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
      }
      sha = parent.sha;
    }
    return sha;
  }

  /** Resolve a suffix-free `base` (a hash, `refs/...` name, or branch name). */
  private async resolveBase(base: string, revision: string): Promise<CommitHash> {
    try {
      if (base.startsWith("refs/")) {
        const tip = await this.refTip(base);
        if (tip === undefined) {
          throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
        }
        return tip;
      }
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        ...this.repo,
        ref: base,
      });
      return z.object({ sha: z.string().transform(parseCommitHash) }).parse(data).sha;
    } catch (error) {
      if (isStatus(error, 404) || isStatus(error, 422)) {
        throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
      }
      throw error;
    }
  }

  async branchTip(branch: RefName): Promise<CommitHash | undefined> {
    return this.refTip(`refs/heads/${branch}`);
  }

  async remoteTip(): Promise<CommitHash | undefined> {
    // This repository is the origin itself: there is no separately fetched
    // copy that could lag behind it.
    return undefined;
  }

  /** The commit `ref` (a full `refs/...` name) points at, or undefined if it does not exist. */
  private async refTip(ref: string): Promise<CommitHash | undefined> {
    try {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ...this.repo,
        ref: ref.slice("refs/".length),
      });
      const { object } = RefSchema.parse(data);
      if (object.type !== "commit") {
        throw new Error(`ref does not name a commit: ${ref} (${object.type})`);
      }
      return object.sha;
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  /** The Git-database commit object at `sha`. */
  private commit(sha: CommitHash): Promise<z.infer<typeof CommitSchema>> {
    return this.cached(this.commits, sha, async () => {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        ...this.repo,
        commit_sha: sha,
      });
      return CommitSchema.parse(data);
    });
  }

  async createBranch(name: RefName, commit: CommitHash): Promise<void> {
    // GitHub rejects a ref that already exists, matching update-ref's
    // empty-old-value guard.
    await this.client.request("POST /repos/{owner}/{repo}/git/refs", {
      ...this.repo,
      ref: `refs/heads/${name}`,
      sha: commit,
    });
  }

  async renameChange(): Promise<void> {
    throw new UserError("renaming needs the atomic ref transaction of a local repository; rename from a checkout");
  }

  /** Compare `basehead` (e.g. "a...b"), trimming the commit list the answer does not need. */
  private async compare(basehead: string): Promise<z.infer<typeof CompareSchema>> {
    const { data } = await this.client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      ...this.repo,
      basehead,
      per_page: 1,
    });
    return CompareSchema.parse(data);
  }

  async mergeBase(a: RefName, b: RefName): Promise<CommitHash> {
    // The heads/ pinning GitBackend gets from refs/heads is not expressible
    // here: compare takes any commitish, so a same-named tag could shadow a
    // branch. Accepted; Cabaret repositories name changes, not tags.
    const { merge_base_commit } = await this.compare(`${a}...${b}`);
    return merge_base_commit.sha;
  }

  isAncestor(ancestor: CommitHash, descendant: CommitHash): Promise<boolean> {
    return this.cached(this.ancestry, `${ancestor}..${descendant}`, async () => {
      // The head is "ahead" (or the same commit) exactly when the base is its
      // ancestor.
      const { status } = await this.compare(`${ancestor}...${descendant}`);
      return status === "ahead" || status === "identical";
    });
  }

  async rebaseOnto(): Promise<void> {
    throw new UserError("rebasing needs a working tree; rebase from a local checkout");
  }

  merge(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash> {
    return this.commitLand(into, tip, message, [onto, tip]);
  }

  squash(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash> {
    return this.commitLand(into, tip, message, [onto]);
  }

  private async commitLand(
    into: RefName,
    tip: CommitHash,
    message: string,
    parents: readonly CommitHash[],
  ): Promise<CommitHash> {
    const tree = (await this.commit(tip)).tree.sha;
    const { data } = await this.client.request("POST /repos/{owner}/{repo}/git/commits", {
      ...this.repo,
      message,
      tree,
      parents: [...parents],
    });
    const commit = z.object({ sha: z.string().transform(parseCommitHash) }).parse(data).sha;
    // Unforced ref updates are fast-forward-only: weaker than the promised
    // points-at-`onto` check, since a concurrent move of `into` to some other
    // ancestor of the new commit would be overtaken — but the race that
    // occurs, a concurrent land advancing `into`, fails here as promised.
    // GitHub's API offers no exact compare-and-swap to close the gap.
    await this.client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      ...this.repo,
      ref: `heads/${into}`,
      sha: commit,
      force: false,
    });
    return commit;
  }

  landMerges(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]> {
    return this.cached(this.lands, `${base}..${tip}`, () => this.landMergesUncached(base, tip));
  }

  private async landMergesUncached(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]> {
    // One compare call lists exactly `git log base..tip` — the commits
    // reachable from tip but not from base. Walking first parents within
    // that set finds the first-parent chain and stops where the chain
    // reaches history the base can see, which need not be base itself when
    // history merged the parent in rather than rebasing. A land merge's onto
    // is its first parent; a squash land's, its sole parent. Trusting the
    // trailer on a single-parent commit does mean a cherry-pick of a land
    // commit — which copies the message verbatim — is skipped too, even
    // though its diff (conflict resolutions included) may match nothing that
    // was reviewed.
    const listed: z.infer<typeof CompareCommitsSchema>["commits"] = [];
    for (let page = 1; ; page++) {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        ...this.repo,
        basehead: `${base}...${tip}`,
        per_page: 100,
        page,
      });
      const { total_commits, commits } = CompareCommitsSchema.parse(data);
      listed.push(...commits);
      if (listed.length >= total_commits || commits.length === 0) {
        break;
      }
    }
    const bySha = new Map(listed.map((commit) => [commit.sha, commit]));
    const merges: LandMerge[] = [];
    for (let commit = bySha.get(tip); commit !== undefined; ) {
      const onto = commit.parents[0]?.sha;
      if (onto === undefined) {
        break;
      }
      if (hasLandTrailer(commit.commit.message)) {
        merges.push({ commit: commit.sha, onto });
      }
      commit = bySha.get(onto);
    }
    return merges.reverse();
  }

  async pushBranch(): Promise<void> {
    // This backend already operates on origin; there is nothing to push to.
  }

  async fetchBranch(): Promise<void> {
    // This backend already operates on origin; there is nothing to fetch from.
  }

  async syncLog(): Promise<void> {
    // This backend already operates on origin: reads see its logs and appends
    // land in them, so local and remote cannot diverge.
  }

  async syncLogs(): Promise<readonly RefName[]> {
    return this.listChanges();
  }

  readFile(commit: CommitHash, file: FilePath): Promise<string | undefined> {
    return this.cached(this.contents, `${commit}:${file}`, () => this.readFileUncached(commit, file));
  }

  private async readFileUncached(commit: CommitHash, file: FilePath): Promise<string | undefined> {
    try {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/contents/{path}", {
        ...this.repo,
        path: file,
        ref: commit,
        // Raw bytes rather than the JSON envelope: no base64 round-trip, and
        // the 1 MiB JSON-content ceiling does not apply.
        mediaType: { format: "raw" },
      });
      return z.string().parse(data);
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  changedFiles(base: CommitHash, tip: CommitHash): Promise<readonly FilePath[]> {
    return this.cached(this.diffs, `${base}..${tip}`, () => this.changedFilesUncached(base, tip));
  }

  private async changedFilesUncached(base: CommitHash, tip: CommitHash): Promise<readonly FilePath[]> {
    // Diffing two recursive tree listings rather than asking compare, which
    // silently caps its file list at 300. The tree diff is also exactly
    // GitBackend's semantics for free: no rename detection (a moved file is
    // its old path plus its new one), and submodules — tree entries of type
    // "commit" — are not files and never listed.
    const [baseTree, tipTree] = await Promise.all([this.blobIds(base), this.blobIds(tip)]);
    const paths = new Set<string>();
    for (const [path, id] of baseTree) {
      if (tipTree.get(path) !== id) {
        paths.add(path);
      }
    }
    for (const [path, id] of tipTree) {
      if (baseTree.get(path) !== id) {
        paths.add(path);
      }
    }
    return [...paths].sort().map(parseFilePath);
  }

  /** Every file at `commit` by path, identified by mode plus blob hash so chmods count as changes. */
  private async blobIds(commit: CommitHash): Promise<ReadonlyMap<string, string>> {
    const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      ...this.repo,
      tree_sha: (await this.commit(commit)).tree.sha,
      recursive: "1",
    });
    const { truncated, tree } = TreeSchema.parse(data);
    // GitHub truncates listings past 100k entries with no way to page; a
    // silent partial diff would misreport review state, so refuse.
    if (truncated) {
      throw new Error(`tree too large to list: ${commit}`);
    }
    return new Map(tree.filter(({ type }) => type === "blob").map(({ path, mode, sha }) => [path, `${mode} ${sha}`]));
  }

  async listChanges(): Promise<readonly RefName[]> {
    const data = await this.client.paginate("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
      ...this.repo,
      ref: LOG_REF_PREFIX.slice("refs/".length),
      per_page: 100,
    });
    return z
      .array(z.object({ ref: z.string() }))
      .parse(data)
      .map(({ ref }) => parseRefName(ref.slice(LOG_REF_PREFIX.length)))
      .sort();
  }

  async readLog(change: RefName): Promise<readonly LogEntry[]> {
    const tip = await this.refTip(`${LOG_REF_PREFIX}${change}`);
    if (tip === undefined) {
      return [];
    }
    return parseLog(await this.logText(tip));
  }

  /** The log file's text at log commit `tip`; a log ref without one is malformed, and fails. */
  private async logText(tip: CommitHash): Promise<string> {
    const text = await this.readFile(tip, parseFilePath(LOG_PATH));
    if (text === undefined) {
      throw new Error(`malformed log commit ${tip}: no ${LOG_PATH} file`);
    }
    return text;
  }

  appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return Promise.resolve();
    }
    // One append per change at a time, and everything asked for while one is
    // in flight rides the next commit together: entries commute, so batching
    // is sound, and it keeps a burst of marks from stacking up a write queue
    // (each append is several throttled writes) — or from racing this
    // client's own compare-and-swap.
    const open = this.waiting.get(change);
    if (open !== undefined) {
      open.entries.push(...entries);
      return open.done;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const batch = { entries: [...entries], done };
    this.waiting.set(change, batch);
    const previous = this.running.get(change) ?? Promise.resolve();
    this.running.set(
      change,
      previous.then(async () => {
        // Seal the batch: appends from here on open the next one.
        this.waiting.delete(change);
        await this.appendNow(change, batch.entries).then(resolve, reject);
      }),
    );
    return done;
  }

  private async appendNow(change: RefName, entries: readonly LogEntry[]): Promise<void> {
    const ref = `${LOG_REF_PREFIX}${change}`;
    // Compare-and-swap on the old tip so a concurrent append can never be
    // silently lost: an unforced update is fast-forward-only, and the new
    // commit fast-forwards from exactly its parent. Losing the swap only
    // means someone else appended first; entries commute (union-merged,
    // timestamp-ordered), so re-reading and retrying is always sound.
    // Bounded so a persistent failure surfaces.
    for (let attempt = 0; ; attempt++) {
      const old = await this.refTip(ref);
      // Read the log pinned at `old` so the content stays consistent with the
      // compare-and-swap below even if the ref moves concurrently.
      const log = old === undefined ? "" : await this.logText(old);
      if (log !== "" && !log.endsWith("\n")) {
        throw new Error(`malformed log for ${change}: missing trailing newline`);
      }
      const { data: blob } = await this.client.request("POST /repos/{owner}/{repo}/git/blobs", {
        ...this.repo,
        content: log + entries.map(formatLogEntry).join(""),
        encoding: "utf-8",
      });
      const { data: tree } = await this.client.request("POST /repos/{owner}/{repo}/git/trees", {
        ...this.repo,
        tree: [
          {
            path: LOG_PATH,
            mode: "100644" as const,
            type: "blob" as const,
            sha: z.object({ sha: z.string() }).parse(blob).sha,
          },
        ],
      });
      const { data: commit } = await this.client.request("POST /repos/{owner}/{repo}/git/commits", {
        ...this.repo,
        message: "cabaret log",
        tree: z.object({ sha: z.string() }).parse(tree).sha,
        parents: old === undefined ? [] : [old],
      });
      const sha = z.object({ sha: z.string() }).parse(commit).sha;
      try {
        if (old === undefined) {
          await this.client.request("POST /repos/{owner}/{repo}/git/refs", { ...this.repo, ref, sha });
        } else {
          await this.client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
            ...this.repo,
            ref: ref.slice("refs/".length),
            sha,
            force: false,
          });
        }
        return;
      } catch (error) {
        // 422 is exactly the lost swap (non-fast-forward, or the ref appearing
        // first); anything else is a real failure.
        if (!isStatus(error, 422) || attempt >= 2) {
          throw error;
        }
      }
    }
  }
}

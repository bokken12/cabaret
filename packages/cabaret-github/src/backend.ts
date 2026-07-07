import {
  type Backend,
  type CommitHash,
  type FilePath,
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
import type { GitHubClient, GitHubRepo } from "./client.js";

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

const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() })),
});

/** Whether `error` is octokit's rejection for HTTP `status`; anything else is a real failure. */
function isStatus(error: unknown, status: number): boolean {
  return (error as { status?: unknown }).status === status;
}

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

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: GitHubRepo,
  ) {}

  async currentBranch(): Promise<RefName> {
    throw new UserError("no branch is checked out over the GitHub API; name the change explicitly");
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
  private async commit(sha: CommitHash): Promise<z.infer<typeof CommitSchema>> {
    const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      ...this.repo,
      commit_sha: sha,
    });
    return CommitSchema.parse(data);
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

  async isAncestor(ancestor: CommitHash, descendant: CommitHash): Promise<boolean> {
    // The head is "ahead" (or the same commit) exactly when the base is its
    // ancestor.
    const { status } = await this.compare(`${ancestor}...${descendant}`);
    return status === "ahead" || status === "identical";
  }

  async rebaseOnto(): Promise<void> {
    throw new UserError("rebasing needs a working tree; rebase from a local checkout");
  }

  async merge(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash> {
    const tree = (await this.commit(tip)).tree.sha;
    const { data } = await this.client.request("POST /repos/{owner}/{repo}/git/commits", {
      ...this.repo,
      message,
      tree,
      parents: [onto, tip],
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

  async landMerges(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]> {
    // Walk the first-parent chain from tip, one commit fetch per step,
    // stopping like `git log base..tip` does: at the first commit reachable
    // from base — which need not be base itself when history merged the
    // parent in rather than rebasing. The trailer marks nothing on a
    // non-merge: only a true merge carries a reviewed child as its second
    // parent, so anything else — say a cherry-pick of a land merge, which
    // copies the message verbatim — still needs review.
    const merges: LandMerge[] = [];
    for (let sha = tip; sha !== base && !(await this.isAncestor(sha, base)); ) {
      const { message, parents } = await this.commit(sha);
      const onto = parents[0]?.sha;
      if (onto === undefined) {
        break;
      }
      if (parents.length > 1 && hasLandTrailer(message)) {
        merges.push({ commit: sha, onto });
      }
      sha = onto;
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

  async readFile(commit: CommitHash, file: FilePath): Promise<string | undefined> {
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

  async changedFiles(base: CommitHash, tip: CommitHash): Promise<readonly FilePath[]> {
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

  async appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
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

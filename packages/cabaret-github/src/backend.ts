import {
  type Backend,
  type ChainMerge,
  type ChangedFile,
  type ChangeName,
  type ConfigScope,
  type FilePath,
  forgeAccount,
  formatLogEntry,
  LAND_TRAILER,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  parseLog,
  type Recommendation,
  type Revision,
  type TimestampMs,
  timestampMs,
  UserError,
  type UserName,
  type Workspace,
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

const ListedCommitSchema = z.object({
  sha: z.string().transform(parseCommitHash),
  commit: z.object({ message: z.string() }),
  parents: z.array(z.object({ sha: z.string().transform(parseCommitHash) })),
});

type ListedCommit = z.infer<typeof ListedCommitSchema>;

const CompareCommitsSchema = z.object({
  total_commits: z.number(),
  commits: z.array(ListedCommitSchema),
});

const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() })),
});

/** Changes per aliased-lookup GraphQL query when sweeping logs and tips. */
const SWEEP_QUERY_BATCH = 100;

/**
 * Ceiling on one stored value; a giant file's text is cheaper to re-fetch
 * than to crowd everything else out of a bounded store.
 */
const MAX_STORED_BYTES = 65536;

/**
 * Versions every durable key. Stored entries are read back as their written
 * shape without validation, and past sessions wrote them — so any change to
 * a stored value's shape must bump this, abandoning the old entries.
 */
const STORE_VERSION = 1;

/**
 * A durable keyed store for immutable git facts, localStorage-shaped. Every
 * key embeds a hash, so entries never go stale — a bounded store can evict
 * freely, and `set` may drop writes it has no room for.
 */
export interface ObjectStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const GraphQLEnvelope = z.object({
  data: z.unknown(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const SweepBatchSchema = z.object({ repository: z.record(z.string(), z.unknown()) });

const SweptLogSchema = z
  .object({
    file: z
      .object({ object: z.object({ isTruncated: z.boolean(), text: z.string().nullable() }).nullable() })
      .nullable(),
  })
  .nullable();

const SweptHeadSchema = z.object({ target: z.object({ oid: z.string().transform(parseCommitHash) }) }).nullable();

/**
 * One fetch epoch's readings: origin's change logs and branch tips as of the
 * last wholesale sweep — the last-fetched copies the `Backend` contract
 * promises. This backend's own writes fold into the held epoch, so a session
 * always sees its own appends without re-fetching.
 */
interface Sweep {
  readonly at: TimestampMs;
  /** Branch tips by change: the sweep's, plus per-epoch read-throughs for names outside it. */
  readonly heads: Map<ChangeName, Promise<Revision | undefined>>;
  /** Each change's log-ref tip and the entries at it. */
  readonly logs: Map<ChangeName, { readonly tip: Revision; readonly entries: readonly LogEntry[] }>;
}

const ShaSchema = z.object({ sha: z.string() });

/** A file at one commit: its mode and blob hash, so chmods count as changes. */
interface TreeEntry {
  readonly mode: string;
  readonly sha: string;
}

/** The change the message's final-paragraph `Cabaret-Landed` trailer names, if any. */
function landedChange(message: string): ChangeName | undefined {
  const paragraphs = message.replace(/\n+$/, "").split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const value = last
    .split("\n")
    .filter((line) => line.startsWith(`${LAND_TRAILER}:`))
    .map((line) => line.slice(LAND_TRAILER.length + 1).trim())
    .join(",");
  return value === "" ? undefined : parseBranchName(value);
}

// Revision suffixes resolveCommit understands: `^` or `^N` selects a parent,
// `~N` walks N first parents.
const REVISION_SUFFIX = /(?:\^(\d*)|~(\d+))$/;

/**
 * A survey's window into a listing of commits. `get` answers from the pages
 * fetched so far; `extend` fetches one more ("page"), or reports the listing
 * finished ("exhausted") or the request budget spent ("budget").
 */
interface ChainLister {
  get(sha: Revision): ListedCommit | undefined;
  extend(): Promise<"page" | "exhausted" | "budget">;
}

/**
 * A `Backend` for a github.com repository, speaking the API directly — no
 * clone, no working tree. Refs, commits, and blobs go through the Git
 * database API, so review state reads and writes work from a browser, which
 * is what `cabaret-web` requires.
 *
 * There is no second repository: this backend talks to `origin` itself, so
 * the sync operations have nothing to reconcile and succeed as no-ops, while
 * the operations that need a working tree or a content merge fail with a
 * `UserError` naming a local checkout as the way out.
 *
 * Mutable state reads by fetch epoch: `fetchOrigin` sweeps every change log
 * and branch tip in a few GraphQL requests, and tips, logs, and the change
 * list answer from that reading — refreshed by the next fetch, and updated
 * in place by this backend's own writes.
 */
export class GitHubBackend implements Backend {
  readonly parseRevision = parseCommitHash;

  readonly parseName = parseBranchName;

  /** There is no working tree; every path is repository-relative. */
  readonly root = "/";

  private user: Promise<UserName> | undefined;
  // Session-scoped settings: there is no git config over the API, so values
  // live in memory and the scopes collapse into one store.
  private readonly settings = new Map<string, string[]>();
  // Git objects and the facts derived from them are immutable once a hash is
  // known, so hash-keyed queries cache for the backend's lifetime: reviewing
  // walks the same history from several pages, and each fact should cost one
  // request per session, not one per page. Mutable reads — refs and the logs
  // behind them — answer from the current fetch epoch's sweep instead.
  private readonly commits = new Map<Revision, Promise<z.infer<typeof CommitSchema>>>();
  private readonly contents = new Map<string, Promise<string | undefined>>();
  private readonly compares = new Map<string, Promise<z.infer<typeof CompareSchema> | undefined>>();
  private readonly trees = new Map<string, Promise<ReadonlyMap<string, TreeEntry>>>();
  private readonly diffs = new Map<string, Promise<readonly ChangedFile[]>>();
  private readonly chains = new Map<
    string,
    Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined; readonly more: boolean }>
  >();
  // Per-change append batching: the open batch still accepting entries, and
  // the settled-or-not tail of the append chain. `running` never rejects —
  // failures surface through each batch's own `done`.
  private readonly waiting = new Map<ChangeName, { entries: LogEntry[]; done: Promise<void> }>();
  private readonly running = new Map<ChangeName, Promise<void>>();
  private sweep: Promise<Sweep> | undefined;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: GitHubRepo,
    private readonly store?: ObjectStore,
  ) {}

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

  /**
   * `cached`, backed by the durable store when one is held: an immutable
   * fact computed once in any session answers from the store forever after.
   * Values are plain data — branded strings and arrays of them — so they
   * round-trip JSON unchanged; the envelope keeps `undefined` storable.
   */
  private durable<K, V>(cache: Map<K, Promise<V>>, space: string, key: K, compute: () => Promise<V>): Promise<V> {
    return this.cached(cache, key, async () => {
      const at = `${STORE_VERSION}:${space}:${String(key)}`;
      const held = this.store?.get(at);
      if (held !== undefined) {
        try {
          return (JSON.parse(held) as { v: V }).v;
        } catch {
          // A mangled entry is a miss; the store is a cache, not a source.
        }
      }
      const value = await compute();
      const encoded = JSON.stringify({ v: value });
      if (encoded.length <= MAX_STORED_BYTES) {
        this.store?.set(at, encoded);
      }
      return value;
    });
  }

  async currentChange(): Promise<ChangeName> {
    throw new UserError("no branch is checked out over the GitHub API; name the change explicitly");
  }

  currentUser(): Promise<UserName> {
    // The token account's `github:<login>` identity — the same mapping the
    // forge applies to PR authors, reviewers, and commenters, so entries
    // written here and entries synced from the forge agree on who one person
    // is; a profile email would split them in two. Only a success is cached:
    // a transient failure must not poison a long-lived session.
    this.user ??= this.client
      .request("GET /user")
      .then(({ data }) => forgeAccount("github", z.object({ login: z.string() }).parse(data).login))
      .catch((error: unknown) => {
        this.user = undefined;
        throw error;
      });
    return this.user;
  }

  resolveFile(raw: string): FilePath {
    // Check the raw spelling too: "" would otherwise normalize into a
    // plausible-looking path instead of failing.
    parseFilePath(raw);
    const parts: string[] = [];
    for (const part of raw.split("/")) {
      if (part === "" || part === ".") {
        continue;
      }
      if (part === "..") {
        if (parts.pop() === undefined) {
          throw new UserError(`path is outside the repository: ${JSON.stringify(raw)}`);
        }
      } else {
        parts.push(part);
      }
    }
    return parseFilePath(parts.join("/"));
  }

  async config(key: string): Promise<string | undefined> {
    const values = this.settings.get(key);
    return values?.[values.length - 1];
  }

  async configAll(key: string): Promise<readonly string[]> {
    return [...(this.settings.get(key) ?? [])];
  }

  async configSet(key: string, value: string, _scope: ConfigScope): Promise<void> {
    this.settings.set(key, [value]);
  }

  async configAdd(key: string, value: string, _scope: ConfigScope): Promise<void> {
    this.settings.set(key, [...(this.settings.get(key) ?? []), value]);
  }

  async configUnset(key: string, _scope: ConfigScope, value?: string): Promise<boolean> {
    const values = this.settings.get(key);
    if (values === undefined) {
      return false;
    }
    const kept = value === undefined ? [] : values.filter((held) => held !== value);
    if (kept.length === values.length) {
      return false;
    }
    if (kept.length === 0) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, kept);
    }
    return true;
  }

  setupRecommendations(): readonly Recommendation[] {
    return [];
  }

  async resolveCommit(revision: string): Promise<Revision> {
    const parents: number[] = [];
    let base = revision;
    for (let match = REVISION_SUFFIX.exec(base); match !== null; match = REVISION_SUFFIX.exec(base)) {
      const [suffix, caret, tilde] = match;
      parents.unshift(...(caret !== undefined ? [Number(caret === "" ? 1 : caret)] : Array(Number(tilde)).fill(1)));
      base = base.slice(0, -suffix.length);
    }
    let sha = await this.resolveBase(base, revision);
    for (const n of parents) {
      const commit = await this.commitObject(sha);
      const parent = commit.parents[n - 1];
      if (parent === undefined) {
        throw new UserError(`unknown revision: ${JSON.stringify(revision)}`);
      }
      sha = parent.sha;
    }
    return sha;
  }

  /** Resolve a suffix-free `base` (a hash, `refs/...` name, or branch name). */
  private async resolveBase(base: string, revision: string): Promise<Revision> {
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

  /** The current fetch epoch, sweeping on the first ask; a failed sweep is not held. */
  private swept(): Promise<Sweep> {
    if (this.sweep === undefined) {
      const sweep: Promise<Sweep> = this.sweepNow().catch((error: unknown) => {
        // Clear only this sweep: a fetch may have installed a fresh epoch
        // that must not be discarded for a stale failure.
        if (this.sweep === sweep) {
          this.sweep = undefined;
        }
        throw error;
      });
      this.sweep = sweep;
    }
    return this.sweep;
  }

  /** The held epoch for a write to fold into, if any; never sweeps. */
  private async sweptIfAny(): Promise<Sweep | undefined> {
    return this.sweep?.catch(() => undefined);
  }

  /**
   * Fold a written branch tip into the epoch a write was predicated on —
   * `held` captured before the write — skipping when a fetch has replaced
   * it: the fresh sweep read the branch itself, and this stale reading must
   * not overwrite what it saw.
   */
  private async foldHead(held: Promise<Sweep> | undefined, change: ChangeName, tip: Revision): Promise<void> {
    if (held === undefined || this.sweep !== held) {
      return;
    }
    (await held.catch(() => undefined))?.heads.set(change, Promise.resolve(tip));
  }

  /**
   * Fold an appended log into the held epoch, so a session reads its own
   * appends without re-fetching. A compare-and-swap on the reading's tip:
   * the fold applies only where the epoch still reads the log tip the
   * append built on — an epoch that swept mid-write already read the ref
   * fresher than `text`, and keeps its own reading.
   */
  private async foldLog(change: ChangeName, old: Revision | undefined, tip: string, text: string): Promise<void> {
    const held = await this.sweptIfAny();
    if (held === undefined) {
      return;
    }
    const reading = held.logs.get(change);
    if (old === undefined ? reading === undefined : reading?.tip === old) {
      held.logs.set(change, { tip: parseCommitHash(tip), entries: parseLog(text, parseCommitHash, parseBranchName) });
    }
  }

  /** One GraphQL request, failing loudly on any reported error. */
  private async graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    const { data } = await this.client.request("POST /graphql", { query, variables });
    const { data: payload, errors } = GraphQLEnvelope.parse(data);
    if (errors !== undefined && errors.length > 0) {
      throw new Error(`GraphQL: ${errors.map(({ message }) => message).join("; ")}`);
    }
    return payload;
  }

  /**
   * Read origin wholesale: list the log refs, then batch every change's log
   * text and branch tip into aliased GraphQL lookups. A render reads logs
   * and tips across all changes; fetched one request at a time, a large
   * repository's home page costs a thousand requests, where sweeping costs a
   * handful. The listing itself stays REST: GraphQL's `refs` field serves
   * only the standard prefixes and answers the log namespace with nothing.
   */
  private async sweepNow(): Promise<Sweep> {
    const listing = z
      .array(z.object({ ref: z.string(), object: z.object({ sha: z.string().transform(parseCommitHash) }) }))
      .parse(
        await this.client.paginate("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
          ...this.repo,
          ref: LOG_REF_PREFIX.slice("refs/".length),
          per_page: 100,
        }),
      )
      .map(({ ref, object }) => ({ change: parseBranchName(ref.slice(LOG_REF_PREFIX.length)), logTip: object.sha }));
    const heads = new Map<ChangeName, Promise<Revision | undefined>>();
    const logs = new Map<ChangeName, { readonly tip: Revision; readonly entries: readonly LogEntry[] }>();
    for (let start = 0; start < listing.length; start += SWEEP_QUERY_BATCH) {
      const batch = listing.slice(start, start + SWEEP_QUERY_BATCH);
      const lookups = batch
        .map(
          ({ change, logTip }, i) =>
            `l${i}: object(oid: ${JSON.stringify(logTip)}) { ... on Commit {` +
            ` file(path: ${JSON.stringify(LOG_PATH)}) { object { ... on Blob { isTruncated text } } } } }` +
            ` h${i}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${change}`)}) { target { ... on Commit { oid } } }`,
        )
        .join(" ");
      const { repository } = SweepBatchSchema.parse(
        await this.graphql(
          `query ($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${lookups} } }`,
          { owner: this.repo.owner, name: this.repo.repo },
        ),
      );
      for (const [i, { change, logTip }] of batch.entries()) {
        const blob = SweptLogSchema.parse(repository[`l${i}`])?.file?.object ?? undefined;
        // An oversized or binary blob comes back truncated or textless;
        // reread it raw rather than serve a partial log.
        const text =
          blob === undefined || blob.text === null || blob.isTruncated ? await this.logText(logTip) : blob.text;
        logs.set(change, { tip: logTip, entries: parseLog(text, parseCommitHash, parseBranchName) });
        heads.set(change, Promise.resolve(SweptHeadSchema.parse(repository[`h${i}`])?.target.oid));
      }
    }
    return { at: timestampMs(Date.now()), heads, logs };
  }

  async tip(change: ChangeName): Promise<Revision | undefined> {
    // The epoch's reading, read through live for a name outside the sweep —
    // a change's parent branch, say — so each such tip costs one request per
    // epoch.
    const sweep = await this.swept();
    return this.cached(sweep.heads, change, () => this.refTip(`refs/heads/${change}`));
  }

  async originTip(change: ChangeName): Promise<Revision | undefined> {
    // This backend reads origin itself: a branch and its origin copy are one
    // reading, the epoch's.
    return this.tip(change);
  }

  async originFetched(): Promise<TimestampMs | undefined> {
    return (await this.swept()).at;
  }

  /** The commit `ref` (a full `refs/...` name) points at, or undefined if it does not exist. */
  private async refTip(ref: string): Promise<Revision | undefined> {
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
  private commitObject(sha: Revision): Promise<z.infer<typeof CommitSchema>> {
    return this.durable(this.commits, "commit", sha, async () => {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        ...this.repo,
        commit_sha: sha,
      });
      return CommitSchema.parse(data);
    });
  }

  async create(change: ChangeName, at: Revision): Promise<void> {
    const held = this.sweep;
    // GitHub rejects a ref that already exists, matching update-ref's
    // empty-old-value guard.
    await this.client.request("POST /repos/{owner}/{repo}/git/refs", {
      ...this.repo,
      ref: `refs/heads/${change}`,
      sha: at,
    });
    await this.foldHead(held, change, at);
  }

  async advance(change: ChangeName, to: Revision): Promise<void> {
    const held = this.sweep;
    // A write reads the ref live, not the epoch's copy: the guard should
    // judge the branch as it stands.
    const tip = await this.refTip(`refs/heads/${change}`);
    if (tip === undefined) {
      throw new UserError(`branch does not exist: ${JSON.stringify(change)}`);
    }
    if (tip !== to) {
      if (!(await this.isAncestor(tip, to))) {
        throw new Error(`cannot advance ${JSON.stringify(change)}: ${to} does not descend from its tip ${tip}`);
      }
      // Unforced ref updates are fast-forward-only, so a concurrent move to
      // anywhere but another ancestor of `to` fails here rather than being
      // overwritten; GitHub's API offers no exact compare-and-swap.
      await this.client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        ...this.repo,
        ref: `heads/${change}`,
        sha: to,
        force: false,
      });
    }
    await this.foldHead(held, change, to);
  }

  async workspaces(): Promise<readonly Workspace[]> {
    return [];
  }

  async addWorkspace(): Promise<void> {
    throw new UserError("workspaces need a local repository; use a local checkout");
  }

  async removeWorkspace(): Promise<void> {
    throw new UserError("workspaces need a local repository; use a local checkout");
  }

  async checkout(): Promise<void> {
    throw new UserError("checking out needs a working tree; use a local checkout");
  }

  async rename(): Promise<void> {
    throw new UserError("renaming needs the atomic ref transaction of a local repository; rename from a checkout");
  }

  async commit(): Promise<never> {
    throw new UserError("committing needs a working tree; commit from a local checkout");
  }

  async hasRevision(revision: Revision): Promise<boolean> {
    try {
      await this.commitObject(revision);
      return true;
    } catch (error) {
      if (isStatus(error, 404) || isStatus(error, 422)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Compare `a...b` (both full hashes, so the answer is immutable), trimming
   * the commit list; undefined when the histories are unrelated, which the
   * API answers with a 404.
   */
  private compare(a: Revision, b: Revision): Promise<z.infer<typeof CompareSchema> | undefined> {
    return this.durable(this.compares, "compare", `${a}...${b}`, async () => {
      try {
        const { data } = await this.client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          ...this.repo,
          basehead: `${a}...${b}`,
          per_page: 1,
        });
        return CompareSchema.parse(data);
      } catch (error) {
        if (isStatus(error, 404)) {
          return undefined;
        }
        throw error;
      }
    });
  }

  async mergeBase(a: Revision, b: Revision): Promise<Revision> {
    const compared = await this.compare(a, b);
    if (compared === undefined) {
      throw new UserError(`no common ancestor: ${a}...${b}`);
    }
    return compared.merge_base_commit.sha;
  }

  async isAncestor(ancestor: Revision, descendant: Revision): Promise<boolean> {
    // The head is "ahead" (or the same commit) exactly when the base is its
    // ancestor; unrelated histories share no ancestor at all.
    const status = (await this.compare(ancestor, descendant))?.status;
    return status === "ahead" || status === "identical";
  }

  async mergedTip(merge: Revision): Promise<Revision> {
    const parent = (await this.commitObject(merge)).parents[1];
    if (parent === undefined) {
      throw new UserError(`not a merge commit: ${merge}`);
    }
    return parent.sha;
  }

  async mergedOnto(merge: Revision): Promise<Revision> {
    const parent = (await this.commitObject(merge)).parents[0];
    if (parent === undefined) {
      throw new UserError(`commit has no parent: ${merge}`);
    }
    return parent.sha;
  }

  async mergeOnto(): Promise<never> {
    throw new UserError("content merges need a local repository; merge from a checkout");
  }

  async mergeConflicts(): Promise<never> {
    throw new UserError("content merges need a local repository; check from a checkout");
  }

  async merge(): Promise<never> {
    throw new UserError("content merges need a local repository; land from a checkout");
  }

  async squash(): Promise<never> {
    throw new UserError("content merges need a local repository; land from a checkout");
  }

  chainMerges(
    base: Revision | undefined,
    tip: Revision,
    scan: number,
  ): Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined; readonly more: boolean }> {
    return this.durable(this.chains, "chain", `${base ?? ""}..${tip}:${scan}`, () =>
      this.chainMergesUncached(base, tip, scan),
    );
  }

  private async chainMergesUncached(
    base: Revision | undefined,
    tip: Revision,
    scan: number,
  ): Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined; readonly more: boolean }> {
    // The API has no first-parent listing, so the chain is reconstructed:
    // page a listing that carries parents, then follow first-parent links
    // through the fetched pages. With a base, the compare listing is exactly
    // the commits of base..tip, so the walk stops where the chain enters the
    // base's ancestry — which need not be base itself when history merged the
    // parent in rather than rebasing. One commit past the scan tells whether
    // the chain continues; a listing that outruns the page budget reports
    // `more` too, since the survey could not finish.
    //
    // The budget covers the scan and its one-commit lookahead, plus one page
    // for the count-revealing first fetch. It bounds requests, not success:
    // merge-heavy history interleaves side commits into the listing, and a
    // chain spread across more pages than the budget reports `more`.
    const budget = Math.ceil((scan + 1) / 100) + 1;
    const lister = base === undefined ? this.commitsLister(tip, budget) : this.compareLister(base, tip, budget);
    const chain: ListedCommit[] = [];
    let truncated = false;
    let at: Revision | undefined = tip;
    walk: while (at !== undefined && chain.length < scan + 1) {
      let commit = lister.get(at);
      while (commit === undefined) {
        const extended = await lister.extend();
        if (extended !== "page") {
          truncated = extended === "budget";
          break walk;
        }
        commit = lister.get(at);
      }
      chain.push(commit);
      at = commit.parents[0]?.sha;
    }
    const surveyed = chain.slice(0, scan);
    const merges: ChainMerge[] = [];
    for (const commit of [...surveyed].reverse()) {
      // A land merge's onto is its first parent; a squash land's, its sole
      // parent. Trusting the trailer on a single-parent commit does mean a
      // cherry-pick of a land commit — which copies the message verbatim —
      // is skipped too, even though its diff (conflict resolutions included)
      // may match nothing that was reviewed.
      const [onto, merged] = commit.parents;
      const landed = landedChange(commit.commit.message);
      if (onto === undefined || (merged === undefined && landed === undefined)) {
        continue;
      }
      merges.push({ commit: commit.sha, onto: onto.sha, merged: merged?.sha, landed });
    }
    return {
      merges,
      root: surveyed[surveyed.length - 1]?.parents[0]?.sha,
      more: chain.length > scan || truncated,
    };
  }

  /** Pages of `base...tip`'s compare listing: exactly the commits of base..tip. */
  private compareLister(base: Revision, tip: Revision, budget: number): ChainLister {
    const listed = new Map<Revision, ListedCommit>();
    // The listing runs oldest to newest and the walk starts at the tip, so
    // after the first page reveals the count, pages fetch back from the end.
    let queue: number[] | undefined;
    let pages = 0;
    const fetchPage = async (page: number): Promise<number> => {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        ...this.repo,
        basehead: `${base}...${tip}`,
        per_page: 100,
        page,
      });
      const { total_commits, commits } = CompareCommitsSchema.parse(data);
      for (const commit of commits) {
        listed.set(commit.sha, commit);
      }
      return total_commits;
    };
    return {
      get: (sha) => listed.get(sha),
      extend: async () => {
        if (pages >= budget) {
          return "budget";
        }
        if (queue === undefined) {
          pages++;
          const total = await fetchPage(1);
          queue = [];
          for (let page = Math.ceil(total / 100); page >= 2; page--) {
            queue.push(page);
          }
          return "page";
        }
        const page = queue.shift();
        if (page === undefined) {
          return "exhausted";
        }
        pages++;
        await fetchPage(page);
        return "page";
      },
    };
  }

  /** Pages of the commits reachable from `tip`, newest first — for surveying a long-lived branch with no base. */
  private commitsLister(tip: Revision, budget: number): ChainLister {
    const listed = new Map<Revision, ListedCommit>();
    let page = 0;
    let done = false;
    return {
      get: (sha) => listed.get(sha),
      extend: async () => {
        if (done) {
          return "exhausted";
        }
        if (page >= budget) {
          return "budget";
        }
        page++;
        const { data } = await this.client.request("GET /repos/{owner}/{repo}/commits", {
          ...this.repo,
          sha: tip,
          per_page: 100,
          page,
        });
        const commits = z.array(ListedCommitSchema).parse(data);
        for (const commit of commits) {
          listed.set(commit.sha, commit);
        }
        done = commits.length < 100;
        return "page";
      },
    };
  }

  async push(): Promise<void> {
    // This backend already operates on origin; there is nothing to push to.
  }

  async fetch(): Promise<void> {
    // This backend already operates on origin; there is nothing to fetch from.
  }

  async fetchOrigin(): Promise<void> {
    // Start a fresh epoch: reads answer from the new sweep.
    this.sweep = undefined;
    await this.swept();
  }

  async advanceBranches(): Promise<readonly ChangeName[]> {
    // The local branches are origin's branches themselves; none can trail.
    return [];
  }

  async syncLog(): Promise<void> {
    // This backend already operates on origin: reads see its logs and appends
    // land in them, so local and remote cannot diverge.
  }

  async syncLogs(): Promise<readonly ChangeName[]> {
    return this.listChanges();
  }

  async wipeReviewState(): Promise<readonly ChangeName[]> {
    // The logs live on origin itself, out of this wipe's scope, and nothing
    // is held on this side.
    return [];
  }

  async wipeOriginLogs(): Promise<readonly ChangeName[]> {
    const changes = await this.listChanges();
    for (const change of changes) {
      await this.deleteLog(change);
    }
    return changes;
  }

  async deleteLog(change: ChangeName): Promise<void> {
    // The log lives on origin alone; deleting the ref there deletes it
    // everywhere this backend sees.
    try {
      await this.client.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        ...this.repo,
        ref: `${LOG_REF_PREFIX.slice("refs/".length)}${change}`,
      });
    } catch (error) {
      // 422 is the ref already being gone — someone else deleted it
      // concurrently, which is not a failure.
      if (!isStatus(error, 422)) {
        throw error;
      }
    }
    (await this.sweptIfAny())?.logs.delete(change);
  }

  readFile(commit: Revision, file: FilePath): Promise<string | undefined> {
    return this.durable(this.contents, "file", `${commit}:${file}`, () => this.readFileUncached(commit, file));
  }

  private async readFileUncached(commit: Revision, file: FilePath): Promise<string | undefined> {
    try {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/contents/{path}", {
        ...this.repo,
        path: file,
        ref: commit,
        // Raw bytes rather than the JSON envelope: no base64 round-trip, and
        // the 1 MiB JSON-content ceiling does not apply.
        mediaType: { format: "raw" },
      });
      // The raw format only applies to files; a directory still answers with
      // its JSON listing, and holds no file text to read.
      return typeof data === "string" ? data : undefined;
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  changedFiles(base: Revision, tip: Revision): Promise<readonly ChangedFile[]> {
    return this.durable(this.diffs, "diff", `${base}..${tip}`, () => this.changedFilesUncached(base, tip));
  }

  private async changedFilesUncached(base: Revision, tip: Revision): Promise<readonly ChangedFile[]> {
    // Diffing two recursive tree listings rather than asking compare, which
    // silently caps its file list at 300 with no way to page it. The tree
    // diff is complete, and submodules — tree entries of type "commit" — are
    // not files and never listed. Moves and copies pair by blob hash alone:
    // an unchanged move (or a copy of a file modified in the same diff, the
    // sources `git diff --find-copies` considers) is recognized, while an
    // edited move goes unpaired — pairing by content similarity would need
    // the diff engine itself.
    const [baseTree, tipTree] = await Promise.all([this.treeEntries(base), this.treeEntries(tip)]);
    const removed: string[] = [];
    const modified: string[] = [];
    const added: string[] = [];
    for (const [path, entry] of baseTree) {
      const other = tipTree.get(path);
      if (other === undefined) {
        removed.push(path);
      } else if (other.mode !== entry.mode || other.sha !== entry.sha) {
        modified.push(path);
      }
    }
    for (const path of tipTree.keys()) {
      if (!baseTree.has(path)) {
        added.push(path);
      }
    }
    removed.sort();
    modified.sort();
    added.sort();
    // Smallest paths claim first, so pairing is deterministic when several
    // candidates hold one blob.
    const removedBySha = new Map<string, string[]>();
    for (const path of removed) {
      const sha = (baseTree.get(path) as TreeEntry).sha;
      const paths = removedBySha.get(sha);
      if (paths === undefined) {
        removedBySha.set(sha, [path]);
      } else {
        paths.push(path);
      }
    }
    const modifiedBySha = new Map<string, string>();
    for (const path of modified) {
      const sha = (baseTree.get(path) as TreeEntry).sha;
      if (!modifiedBySha.has(sha)) {
        modifiedBySha.set(sha, path);
      }
    }
    const claimed = new Set<string>();
    const files: ChangedFile[] = [];
    for (const path of added) {
      const sha = (tipTree.get(path) as TreeEntry).sha;
      const moved = removedBySha.get(sha)?.shift();
      if (moved !== undefined) {
        claimed.add(moved);
        files.push({ path: parseFilePath(path), source: { path: parseFilePath(moved), copied: false } });
        continue;
      }
      const copied = modifiedBySha.get(sha);
      files.push({
        path: parseFilePath(path),
        source: copied === undefined ? undefined : { path: parseFilePath(copied), copied: true },
      });
    }
    for (const path of removed) {
      if (!claimed.has(path)) {
        files.push({ path: parseFilePath(path), source: undefined });
      }
    }
    for (const path of modified) {
      files.push({ path: parseFilePath(path), source: undefined });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Every file at `commit` by path, keyed off the commit's (immutable) tree. */
  private async treeEntries(commit: Revision): Promise<ReadonlyMap<string, TreeEntry>> {
    const tree = (await this.commitObject(commit)).tree.sha;
    return this.cached(this.trees, tree, async () => {
      const { data } = await this.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        ...this.repo,
        tree_sha: tree,
        recursive: "1",
      });
      const listing = TreeSchema.parse(data);
      // GitHub truncates listings past 100k entries with no way to page; a
      // silent partial diff would misreport review state, so refuse.
      if (listing.truncated) {
        throw new Error(`tree too large to list: ${commit}`);
      }
      return new Map(
        listing.tree.filter(({ type }) => type === "blob").map(({ path, mode, sha }) => [path, { mode, sha }]),
      );
    });
  }

  async listChanges(): Promise<readonly ChangeName[]> {
    return [...(await this.swept()).logs.keys()].sort();
  }

  async readLog(change: ChangeName): Promise<readonly LogEntry[]> {
    return (await this.swept()).logs.get(change)?.entries ?? [];
  }

  /** The log file's text at log commit `tip`; a log ref without one is malformed, and fails. */
  private async logText(tip: Revision): Promise<string> {
    const text = await this.readFile(tip, parseFilePath(LOG_PATH));
    if (text === undefined) {
      throw new Error(`malformed log commit ${tip}: no ${LOG_PATH} file`);
    }
    return text;
  }

  appendLog(change: ChangeName, entries: readonly LogEntry[]): Promise<void> {
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

  private async appendNow(change: ChangeName, entries: readonly LogEntry[]): Promise<void> {
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
      const text = log + entries.map(formatLogEntry).join("");
      const { data: blob } = await this.client.request("POST /repos/{owner}/{repo}/git/blobs", {
        ...this.repo,
        content: text,
        encoding: "utf-8",
      });
      const { data: tree } = await this.client.request("POST /repos/{owner}/{repo}/git/trees", {
        ...this.repo,
        tree: [
          {
            path: LOG_PATH,
            mode: "100644" as const,
            type: "blob" as const,
            sha: ShaSchema.parse(blob).sha,
          },
        ],
      });
      const { data: commit } = await this.client.request("POST /repos/{owner}/{repo}/git/commits", {
        ...this.repo,
        message: "cabaret log",
        tree: ShaSchema.parse(tree).sha,
        parents: old === undefined ? [] : [old],
      });
      const sha = ShaSchema.parse(commit).sha;
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
        await this.foldLog(change, old, sha, text);
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

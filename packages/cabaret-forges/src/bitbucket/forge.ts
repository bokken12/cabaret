import {
  type ChangeName,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeCursor,
  type ForgeLocator,
  type ForgeMerge,
  type ForgeSweep,
  forgeAccount,
  forgeChangeId,
  forgeCursor,
  type LandMethod,
  parseBranchName,
  parseCommitHash,
  parseForgeLocator,
  type Revision,
  type Self,
  type SweptChange,
  timestampMs,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { z } from "zod";
import { type BitbucketClient, type BitbucketRepo, isStatus } from "./client.js";

// This package compiles against bare es2025 to stay platform-agnostic, so the
// runtime-provided timer is declared rather than imported from a lib.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** The identity for a Bitbucket account: its nickname under the `bitbucket:` scheme. */
function accountUser(nickname: string): UserName {
  return forgeAccount("bitbucket", nickname);
}

// Bitbucket serves a deleted account as a user record with no nickname, so
// this fixed identity keeps the mapping total.
const GHOST = accountUser("ghost");

// Inverts `accountUser`.
const ACCOUNT = /^bitbucket:(.+)$/;

/**
 * The nickname a Cabaret identity names — `accountUser`'s inverse. Fails for
 * an identity that names no account: emails are not searched, since
 * Bitbucket offers no exact email lookup and a review request must never
 * land on whichever stranger matched first.
 */
function accountNickname(user: UserName): string {
  const nickname = ACCOUNT.exec(user)?.[1];
  if (nickname === undefined) {
    throw new UserError(`${JSON.stringify(user)} names no bitbucket.org account; use bitbucket:<nickname>`);
  }
  return nickname;
}

// An account reference, as authors, reviewers, and comment authors carry it.
const AccountSchema = z.object({ nickname: z.string().optional() }).nullable();

/** The Cabaret identity of an account reference. */
function identity(account: z.infer<typeof AccountSchema>): UserName {
  return account?.nickname === undefined ? GHOST : accountUser(account.nickname);
}

// Bitbucket truncates the commit hashes embedded in pull-request objects to
// twelve characters; a hash this matches needs no resolution round trip.
const FULL_HASH = /^[0-9a-f]{40}$/;

const PrSchema = z.object({
  id: z.number().transform(forgeChangeId),
  title: z.string(),
  author: AccountSchema,
  state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]),
  draft: z.boolean(),
  updated_on: z.string(),
  comment_count: z.number(),
  source: z.object({
    branch: z.object({ name: z.string().transform(parseBranchName) }),
    commit: z.object({ hash: z.string() }),
  }),
  destination: z.object({ branch: z.object({ name: z.string().transform(parseBranchName) }) }),
  merge_commit: z.object({ hash: z.string() }).nullable(),
  reviewers: z.array(AccountSchema),
});

type Pr = z.infer<typeof PrSchema>;

// The pull-request listing omits reviewers unless asked; `+` keeps the rest
// of the resource alongside them.
const LIST_FIELDS = "+values.reviewers";

const CommentSchema = z.object({
  id: z.number(),
  user: AccountSchema,
  content: z.object({ raw: z.string() }),
  updated_on: z.string(),
  deleted: z.boolean(),
  pending: z.boolean().optional(),
  inline: z.unknown().optional(),
});

const CommitSchema = z.object({
  hash: z.string().transform(parseCommitHash),
  parents: z.array(z.object({ hash: z.string().transform(parseCommitHash) })),
});

/** A string literal in Bitbucket's query grammar. */
function quoted(raw: string): string {
  return `"${raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * How far back a minted cursor trails the newest activity a sweep read.
 * Stamps may be written by async workers, and a read may come from a lagging
 * replica; the overlap re-reads that window, which absorption tolerates.
 */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

/** The forge-clock epoch milliseconds a cursor resumes from; undefined resweeps the open set. */
function cursorMs(since: ForgeCursor | undefined): number | undefined {
  if (since === undefined) {
    return undefined;
  }
  const ms = Number(since);
  return Number.isNaN(ms) ? undefined : ms;
}

// A merge accepted with 202 completes asynchronously; the pull request is
// polled until it reports merged, and a merge that outlives every poll is
// genuinely stuck.
const MERGE_POLLS = 30;

/** A `Forge` for a bitbucket.org repository, speaking the API directly. */
export class BitbucketForge implements Forge {
  readonly locator: ForgeLocator;
  /** The API path prefix naming the repository. */
  private readonly api: string;
  private readonly pollMs: number;

  constructor(
    private readonly client: BitbucketClient,
    private readonly repo: BitbucketRepo,
    { pollMs = 2000 }: { readonly pollMs?: number } = {},
  ) {
    this.locator = parseForgeLocator(`bitbucket.org/${repo.workspace}/${repo.slug}`);
    this.api = `/repositories/${repo.workspace}/${repo.slug}`;
    this.pollMs = pollMs;
  }

  async currentSelf(): Promise<Self> {
    const user = z.object({ nickname: z.string() }).parse(await this.client.get("/user"));
    const emails = z
      .array(z.object({ email: z.string(), is_confirmed: z.boolean() }))
      .parse(await this.client.getPaginated("/user/emails"));
    const aliases = new Set<UserName>();
    for (const { email, is_confirmed } of emails) {
      if (is_confirmed) {
        aliases.add(userName(email));
      }
    }
    return { user: accountUser(user.nickname), aliases };
  }

  /** The full hash of `short`, resolved through the commit endpoint when Bitbucket truncated it. */
  private async revisionOf(short: string): Promise<Revision> {
    if (FULL_HASH.test(short)) {
      return parseCommitHash(short);
    }
    const commit = z.object({ hash: z.string().transform(parseCommitHash) });
    return commit.parse(await this.client.get(`${this.api}/commit/${short}`, { fields: "hash" })).hash;
  }

  private async toChange(pr: Pr): Promise<ForgeChange> {
    const tip = await this.revisionOf(pr.source.commit.hash);
    return {
      id: pr.id,
      head: pr.source.branch.name,
      tip,
      parent: pr.destination.branch.name,
      title: pr.title,
      author: identity(pr.author),
      // A declined or superseded pull request is closed without merging.
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      draft: pr.draft,
      // Sorted by identity: the forge promises no order of its own.
      reviewers: pr.reviewers.map(identity).sort(),
      ...(pr.state === "MERGED" ? { merge: await this.mergeOf(pr, tip) } : {}),
    };
  }

  private async mergeOf(pr: Pr, tip: Revision): Promise<ForgeMerge> {
    // A merged pull request without a recorded merge commit had its head
    // fast-forwarded or otherwise adopted directly; the head itself is the
    // best name for what landed.
    return this.landingShape(pr.merge_commit?.hash ?? tip, tip);
  }

  /**
   * How `commit` landed a pull request whose reviewed head was `tip`.
   * Bitbucket's landing shapes: a true merge's commit carries the reviewed
   * head as its second parent; squash and fast-forward put single-parent
   * commits on the target. Only the true merge preserves review ancestry, so
   * only it reports 2. Reading the commit also resolves the truncated hash
   * pull-request objects carry.
   */
  private async landingShape(commit: string, tip: Revision): Promise<ForgeMerge> {
    const { hash, parents } = CommitSchema.parse(
      await this.client.get(`${this.api}/commit/${commit}`, { fields: "hash,parents.hash" }),
    );
    return { commit: hash, parents: parents.length === 2 && parents[1]?.hash === tip ? 2 : 1 };
  }

  private toComment(comment: z.infer<typeof CommentSchema>): ForgeComment {
    return {
      id: String(comment.id),
      author: identity(comment.user),
      body: comment.content.raw,
      updatedAt: timestampMs(Date.parse(comment.updated_on)),
    };
  }

  private async listPrs(query: Readonly<Record<string, string | readonly string[]>>): Promise<readonly Pr[]> {
    const data = await this.client.getPaginated(`${this.api}/pullrequests`, { ...query, fields: LIST_FIELDS });
    return z.array(PrSchema).parse(data);
  }

  async findChange(branch: ChangeName): Promise<ForgeChange | undefined> {
    // Several open pull requests on one branch collapse to the lowest id,
    // the one `fetchForge` would import.
    const found = [...(await this.listPrs({ state: "OPEN", q: `source.branch.name = ${quoted(branch)}` }))].sort(
      (a, b) => a.id - b.id,
    )[0];
    return found === undefined ? undefined : this.toChange(found);
  }

  private async toSweptChange(pr: Pr): Promise<SweptChange> {
    return {
      change: await this.toChange(pr),
      comments: pr.comment_count === 0 ? [] : await this.listComments(pr.id),
      commentsTruncated: false,
    };
  }

  async fetchChanges(since: ForgeCursor | undefined): Promise<ForgeSweep> {
    // Bitbucket has no bulk query, so the sweep costs a few calls per pull
    // request it carries; in return every discussion comes back whole, and
    // nothing truncates. A cursor narrows the carried set to what the forge
    // stamped touched after it, every state included — the listing filters
    // to open alone unless each state is asked for.
    const resume = cursorMs(since);
    const prs =
      resume === undefined
        ? await this.listPrs({ state: "OPEN" })
        : await this.listPrs({
            state: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
            q: `updated_on > ${quoted(new Date(resume).toISOString())}`,
          });
    const changes = await Promise.all(prs.map(this.toSweptChange, this));
    const newest = Math.max(0, ...prs.map(({ updated_on }) => Date.parse(updated_on)));
    // Never regresses: an empty sweep resumes where this one began.
    const minted = Math.max(resume ?? 0, newest - CURSOR_OVERLAP_MS);
    return {
      coverage: resume === undefined ? "open" : "since",
      changes,
      cursor: minted > 0 ? forgeCursor(String(minted)) : undefined,
    };
  }

  private async getPr(id: ForgeChangeId): Promise<Pr> {
    let data: unknown;
    try {
      data = await this.client.get(`${this.api}/pullrequests/${id}`);
    } catch (error) {
      if (isStatus(error, 404)) {
        throw new UserError(`no pull request #${id} on ${this.locator}`);
      }
      throw error;
    }
    return PrSchema.parse(data);
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    return this.toChange(await this.getPr(id));
  }

  async createChange(head: ChangeName, parent: ChangeName, title: string): Promise<ForgeChange> {
    // The response names the new pull request; fetching by its id — never by
    // head, which could race another pull request on the same branch —
    // reuses the one query that maps a pull request.
    const data = await this.client.post(`${this.api}/pullrequests`, {
      title,
      source: { branch: { name: head } },
      destination: { branch: { name: parent } },
    });
    return this.getChange(forgeChangeId(z.object({ id: z.number() }).parse(data).id));
  }

  async setParent(id: ForgeChangeId, parent: ChangeName): Promise<void> {
    await this.client.put(`${this.api}/pullrequests/${id}`, { destination: { branch: { name: parent } } });
  }

  async setState(id: ForgeChangeId, state: "open" | "closed"): Promise<void> {
    // Declining is Bitbucket's close, and it is final: nothing in the API
    // reopens a declined pull request.
    if (state === "open") {
      throw new UserError(`${this.locator}#${id} is declined, which bitbucket.org cannot reopen`);
    }
    await this.client.post(`${this.api}/pullrequests/${id}/decline`, {});
  }

  async setDraft(id: ForgeChangeId, draft: boolean): Promise<void> {
    await this.client.put(`${this.api}/pullrequests/${id}`, { draft });
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    tip: Revision,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    // The merge call takes no expected head, so the freshest read Bitbucket
    // offers stands in: a push racing the window between this check and the
    // merge can still land unreviewed commits, which Bitbucket gives no way
    // to close.
    const current = await this.getPr(id);
    if (!tip.startsWith(current.source.commit.hash)) {
      throw new UserError(`${this.locator}#${id} is not at the validated tip; run \`cab sync\` first`);
    }
    let data: unknown;
    try {
      // Bitbucket takes whole commit messages, not a title/body split.
      data = await this.client.post(`${this.api}/pullrequests/${id}/merge`, {
        message: `${title}\n\n${message}`,
        merge_strategy: method === "squash" ? "squash" : "merge_commit",
      });
    } catch (error) {
      // 400 and 409 are Bitbucket refusing the merge as such — an unmet
      // merge check, or a pull request that does not merge cleanly; both are
      // the user's to resolve, and Bitbucket's message says which it was.
      if (isStatus(error, 400) || isStatus(error, 409)) {
        throw new UserError(`${this.locator}#${id} did not merge: ${(error as Error).message}`);
      }
      throw error;
    }
    // A 200 response carries the merged pull request; a 202 means the merge
    // continues asynchronously, so the pull request is polled until it lands.
    let pr = PrSchema.safeParse(data).data;
    for (let poll = 0; pr === undefined || pr.state !== "MERGED"; poll++) {
      if (pr !== undefined && pr.state !== "OPEN") {
        throw new UserError(`${this.locator}#${id} did not merge: the pull request is ${pr.state.toLowerCase()}`);
      }
      if (poll >= MERGE_POLLS) {
        throw new UserError(`${this.locator}#${id} merge did not complete; run \`cab sync\` once it has`);
      }
      await new Promise((resolve) => setTimeout(() => resolve(undefined), this.pollMs));
      pr = await this.getPr(id);
    }
    return this.mergeOf(pr, tip);
  }

  async listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]> {
    // Only the change-level discussion: inline comments belong to file
    // review, drafts are unpublished, and deleted comments survive as
    // tombstone records.
    const data = await this.client.getPaginated(`${this.api}/pullrequests/${id}/comments`);
    return (
      z
        .array(CommentSchema)
        .parse(data)
        .filter((comment) => comment.inline === undefined && !comment.deleted && comment.pending !== true)
        // Ids are minted in creation order, oldest first, as the interface
        // promises; Bitbucket pages in that order but does not document it.
        .sort((a, b) => a.id - b.id)
        .map(this.toComment, this)
    );
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    await this.client.post(`${this.api}/pullrequests/${id}/comments`, { content: { raw: body } });
  }

  async updateComment(id: ForgeChangeId, comment: string, body: string): Promise<void> {
    await this.client.put(`${this.api}/pullrequests/${id}/comments/${comment}`, { content: { raw: body } });
  }

  /**
   * The uuid of the workspace member `user` names. Only members are
   * searched — nobody else can review — and a nickname several members share
   * fails rather than guess between them.
   */
  private async memberUuid(user: UserName): Promise<string> {
    const nickname = accountNickname(user);
    const members = z.array(z.object({ user: z.object({ uuid: z.string() }) })).parse(
      await this.client.getPaginated(`/workspaces/${this.repo.workspace}/members`, {
        q: `user.nickname = ${quoted(nickname)}`,
      }),
    );
    const [found, ...rest] = members;
    if (found === undefined) {
      throw new UserError(`no bitbucket.org account "${nickname}" in workspace ${this.repo.workspace}`);
    }
    if (rest.length > 0) {
      throw new UserError(`several accounts in workspace ${this.repo.workspace} share the nickname "${nickname}"`);
    }
    return found.user.uuid;
  }

  async setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void> {
    // Bitbucket has no add/remove calls: the update replaces the whole
    // reviewer list, so the pull request's current one is read and edited.
    // Reviewers already on it carry their uuids; only additions need the
    // member lookup.
    const { reviewers } = z
      .object({ reviewers: z.array(z.object({ uuid: z.string(), nickname: z.string().optional() })) })
      .parse(await this.client.get(`${this.api}/pullrequests/${id}`, { fields: "reviewers.uuid,reviewers.nickname" }));
    const wanted = new Map(reviewers.map((reviewer) => [reviewer.uuid, reviewer.nickname]));
    const removing = new Set(remove.map(accountNickname));
    for (const [uuid, nickname] of wanted) {
      if (nickname !== undefined && removing.has(nickname)) {
        wanted.delete(uuid);
      }
    }
    for (const uuid of await Promise.all(add.map(this.memberUuid, this))) {
      wanted.set(uuid, undefined);
    }
    if (wanted.size === reviewers.length && reviewers.every(({ uuid }) => wanted.has(uuid))) {
      return;
    }
    try {
      await this.client.put(`${this.api}/pullrequests/${id}`, {
        reviewers: [...wanted.keys()].sort().map((uuid) => ({ uuid })),
      });
    } catch (error) {
      // 400 is Bitbucket refusing a reviewer as such — the pull request's
      // own author, or an account without access; the message names it.
      if (isStatus(error, 400)) {
        throw new UserError(`${this.locator}#${id} reviewers not updated: ${(error as Error).message}`);
      }
      throw error;
    }
  }
}

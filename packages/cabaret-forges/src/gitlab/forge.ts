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
import { type GitLabClient, type GitLabProject, isStatus } from "./client.js";

/** The identity for a GitLab account: its username under the `gitlab:` scheme. */
function accountUser(username: string): UserName {
  return forgeAccount("gitlab", username);
}

// GitLab reattributes a deleted account's contributions to a per-instance
// "ghost" user, so an authorless MR is nearly unreachable — but the API
// admits one, and this fixed identity keeps the mapping total.
const GHOST = accountUser("ghost");

// Inverts `accountUser`.
const ACCOUNT = /^gitlab:(.+)$/;

// GitLab's private-commit-email forms name their account just as well, so a
// pasted noreply address is taken as the account it belongs to: the
// id-prefixed form names it outright, the bare form by username.
const NOREPLY = /^(?:(\d+)-)?([^@]+)@users\.noreply\.gitlab\.com$/;

/** The numeric user id in a User gid; a gid in any other shape must not silently pass for an account. */
function userIdOfGid(gid: string): string {
  const id = /^gid:\/\/gitlab\/User\/(\d+)$/.exec(gid)?.[1];
  if (id === undefined) {
    throw new Error(`unexpected user id format: ${gid}`);
  }
  return id;
}

// The MR fields every query selects. GraphQL rather than REST because the
// open-changes sweep pages a hundred MRs with their notes in one query —
// REST would make it N+1.
const MR_FIELDS =
  "iid sourceBranch diffHeadSha targetBranch title author { username } state draft mergeCommitSha reviewers(first: 100) { nodes { username } }";

const MrSchema = z.object({
  // GraphQL serializes the iid as a string.
  iid: z.string().transform((raw) => forgeChangeId(Number(raw))),
  sourceBranch: z.string().transform(parseBranchName),
  diffHeadSha: z.string().transform(parseCommitHash),
  targetBranch: z.string().transform(parseBranchName),
  title: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  draft: z.boolean(),
  mergeCommitSha: z.string().transform(parseCommitHash).nullable(),
  reviewers: z.object({ nodes: z.array(z.object({ username: z.string() })) }).nullable(),
});

const FIND_MR = `query ($path: ID!, $branch: String!) {
  project(fullPath: $path) {
    mergeRequests(sourceBranches: [$branch], state: opened, first: 1) { nodes { ${MR_FIELDS} } }
  }
}`;

// Notes are capped at the first hundred per MR rather than paginated,
// keeping the whole sweep to one query per page of MRs; the page info
// reports the cap so readers needing more fall back to `listComments`.
const SWEPT_CHANGE_FIELDS = `${MR_FIELDS} updatedAt notes(first: 100) { nodes { id author { username } body system updatedAt } pageInfo { hasNextPage } }`;

const FETCH_OPEN_CHANGES = `query ($path: ID!, $first: Int!, $cursor: String) {
  project(fullPath: $path) {
    mergeRequests(state: opened, first: $first, after: $cursor) {
      nodes { ${SWEPT_CHANGE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// Every state: the server filters to what moved after the cursor, so closed
// and merged changes surface with the rest.
const FETCH_CHANGES_SINCE = `query ($path: ID!, $updatedAfter: Time!, $first: Int!, $cursor: String) {
  project(fullPath: $path) {
    mergeRequests(updatedAfter: $updatedAfter, sort: UPDATED_DESC, first: $first, after: $cursor) {
      nodes { ${SWEPT_CHANGE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * Sweeps run close together, so most end within their first page; the query
 * cost the forge charges scales with the requested page size, so pages start
 * small and double toward this cap for the sweeps that are far behind.
 */
const FIRST_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const GET_MR = `query ($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) { ${MR_FIELDS} }
  }
}`;

const USER = "query ($username: String!) { user(username: $username) { id } }";

// GitLab's GraphQL nulls a missing or unauthorized record instead of
// erroring, so every query's schema admits the null and absence is raised as
// a `UserError` naming what was asked for.
const FindMrSchema = z.object({
  project: z.object({ mergeRequests: z.object({ nodes: z.array(MrSchema) }) }).nullable(),
});

// A GraphQL note's id is a gid ("gid://gitlab/Note/123"); the numeric tail is
// the REST note id, which is how `listComments` (and the comment sync built
// on it) identifies the same note.
const NOTE_GID = /(\d+)$/;

const SweptMrSchema = MrSchema.extend({
  updatedAt: z.string(),
  notes: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        author: z.object({ username: z.string() }).nullable(),
        body: z.string(),
        system: z.boolean(),
        updatedAt: z.string(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});

const FetchChangesSchema = z.object({
  project: z
    .object({
      mergeRequests: z.object({
        nodes: z.array(SweptMrSchema),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    })
    .nullable(),
});

/**
 * How far back a minted cursor trails the newest activity a sweep read.
 * GitLab stamps some updates from async workers, and a read may come from a
 * lagging replica; the overlap re-reads that window, which absorption
 * tolerates.
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

const GetMrSchema = z.object({
  project: z.object({ mergeRequest: MrSchema.nullable() }).nullable(),
});

const UserSchema = z.object({
  user: z.object({ id: z.string() }).nullable(),
});

// The merged-commit fields of a REST merge-request object: what the merge
// call returns, and what a merged MR is re-fetched for, since GraphQL
// never exposes the squash commit.
const MergedMrSchema = z.object({
  merge_commit_sha: z.string().transform(parseCommitHash).nullable(),
  squash_commit_sha: z.string().transform(parseCommitHash).nullable(),
  sha: z.string().transform(parseCommitHash),
});

/** The commit a merged REST merge-request object landed on the target branch. */
function landedCommit(mr: z.infer<typeof MergedMrSchema>): Revision {
  // The merge commit when one was made; else the squash commit; else the
  // head itself, which a fast-forward merge put on the target directly.
  return mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha;
}

const CommitSchema = z.object({
  parent_ids: z.array(z.string().transform(parseCommitHash)),
});

const NoteSchema = z.object({
  id: z.number(),
  author: z.object({ username: z.string() }),
  body: z.string(),
  system: z.boolean(),
  updated_at: z.string(),
});

// The reviewer accounts of a REST merge-request object: the state
// `setReviewers` edits, since REST is the only API that writes reviewers.
const ReviewersSchema = z.object({ reviewers: z.array(z.object({ id: z.number() })) });

/** A `Forge` for a gitlab.com project, speaking the API directly. */
export class GitLabForge implements Forge {
  readonly locator: ForgeLocator;
  /** The REST path prefix naming the project. */
  private readonly api: string;

  constructor(
    private readonly client: GitLabClient,
    private readonly project: GitLabProject,
  ) {
    this.locator = parseForgeLocator(`gitlab.com/${project.path}`);
    this.api = `/projects/${encodeURIComponent(project.path)}`;
  }

  async currentSelf(): Promise<Self> {
    // The primary, public, and commit emails are all the account's own
    // identities; absent ones read as "" or null depending on the field.
    const email = z.string().nullish();
    const user = z
      .object({ username: z.string(), email, public_email: email, commit_email: email })
      .parse(await this.client.get("/user"));
    const aliases = new Set<UserName>();
    for (const candidate of [user.email, user.public_email, user.commit_email]) {
      if (candidate !== undefined && candidate !== null && candidate !== "") {
        aliases.add(userName(candidate));
      }
    }
    return { user: accountUser(user.username), aliases };
  }

  /**
   * The numeric user id behind a Cabaret identity — `accountUser` in reverse,
   * also taking GitLab's noreply email forms: the id-prefixed one carries its
   * id outright, the others cost a lookup by username. Fails for an identity
   * that names no account: emails are not searched, since GitLab's matching
   * is too loose for a review request that must never land on whichever
   * stranger matched first.
   */
  private async accountId(user: UserName): Promise<number> {
    const [, id, noreplyUsername] = NOREPLY.exec(user) ?? [];
    if (id !== undefined) {
      return Number(id);
    }
    const username = ACCOUNT.exec(user)?.[1] ?? noreplyUsername;
    if (username === undefined) {
      throw new UserError(`${JSON.stringify(user)} names no gitlab.com account; use gitlab:<username>`);
    }
    const found = UserSchema.parse(await this.client.graphql(USER, { username })).user;
    if (found === null) {
      throw new UserError(`no gitlab.com account found for "${user}"`);
    }
    return Number(userIdOfGid(found.id));
  }

  private async toChange(mr: z.infer<typeof MrSchema>): Promise<ForgeChange> {
    return {
      id: mr.iid,
      head: mr.sourceBranch,
      tip: mr.diffHeadSha,
      parent: mr.targetBranch,
      title: mr.title,
      author: mr.author === null ? GHOST : accountUser(mr.author.username),
      // A locked MR is mid-merge on the server; until that lands it has
      // not merged, so it reads as open.
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      draft: mr.draft,
      // Sorted by identity: the forge promises no order of its own.
      reviewers: (mr.reviewers?.nodes ?? []).map((reviewer) => accountUser(reviewer.username)).sort(),
      ...(mr.state === "merged" ? { merge: await this.mergeOf(mr) } : {}),
    };
  }

  private async mergeOf(mr: z.infer<typeof MrSchema>): Promise<ForgeMerge> {
    // A merge without a merge commit landed something GraphQL never exposes —
    // the squash commit, or a fast-forward of the head itself — so only that
    // case re-fetches the MR over REST.
    const commit =
      mr.mergeCommitSha ??
      landedCommit(MergedMrSchema.parse(await this.client.get(`${this.api}/merge_requests/${mr.iid}`)));
    return this.landingShape(commit, mr.diffHeadSha);
  }

  /**
   * How `commit` landed an MR whose reviewed head was `tip`. GitLab's
   * landing shapes: a true merge's commit carries the reviewed head as its
   * second parent; a squash under the merge-commit method carries the
   * unreviewed squash commit there instead; and the fast-forward variants
   * put a single-parent commit on the target. Only the true merge preserves
   * review ancestry, so only it reports 2.
   */
  private async landingShape(commit: Revision, tip: Revision): Promise<ForgeMerge> {
    const { parent_ids } = CommitSchema.parse(await this.client.get(`${this.api}/repository/commits/${commit}`));
    return { commit, parents: parent_ids.length === 2 && parent_ids[1] === tip ? 2 : 1 };
  }

  private toComment(note: z.infer<typeof NoteSchema>): ForgeComment {
    return {
      id: String(note.id),
      author: accountUser(note.author.username),
      body: note.body,
      updatedAt: timestampMs(Date.parse(note.updated_at)),
    };
  }

  /** `project` from a query's response, which GitLab nulls when it is missing or the token cannot see it. */
  private requireProject<T>(project: T | null): T {
    if (project === null) {
      throw new UserError(`no project ${this.project.path} on gitlab.com, or the token cannot see it`);
    }
    return project;
  }

  async findChange(branch: ChangeName): Promise<ForgeChange | undefined> {
    const out = await this.client.graphql(FIND_MR, { path: this.project.path, branch });
    const found = this.requireProject(FindMrSchema.parse(out).project).mergeRequests.nodes[0];
    return found === undefined ? undefined : this.toChange(found);
  }

  private async toSweptChange(mr: z.infer<typeof SweptMrSchema>): Promise<SweptChange> {
    const comments = mr.notes.nodes
      .filter((note) => !note.system)
      .map((note) => {
        const id = NOTE_GID.exec(note.id)?.[1];
        // A gid in any other shape must not silently desynchronize these
        // note identities from REST's.
        if (id === undefined) {
          throw new Error(`unexpected note id format: ${note.id}`);
        }
        return {
          id,
          author: note.author === null ? GHOST : accountUser(note.author.username),
          body: note.body,
          updatedAt: timestampMs(Date.parse(note.updatedAt)),
        };
      });
    // System notes are filtered after the cap, so a capped page may over-
    // report truncation; the fallback just re-lists what was already whole.
    return { change: await this.toChange(mr), comments, commentsTruncated: mr.notes.pageInfo.hasNextPage };
  }

  async fetchChanges(since: ForgeCursor | undefined): Promise<ForgeSweep> {
    const resume = cursorMs(since);
    const changes: Promise<SweptChange>[] = [];
    let newest = 0;
    let cursor: string | null = null;
    let first = FIRST_PAGE_SIZE;
    do {
      const out: unknown =
        resume === undefined
          ? await this.client.graphql(FETCH_OPEN_CHANGES, { path: this.project.path, first, cursor })
          : await this.client.graphql(FETCH_CHANGES_SINCE, {
              path: this.project.path,
              updatedAfter: new Date(resume).toISOString(),
              first,
              cursor,
            });
      first = Math.min(first * 2, MAX_PAGE_SIZE);
      const { nodes, pageInfo } = this.requireProject(FetchChangesSchema.parse(out).project).mergeRequests;
      for (const mr of nodes) {
        newest = Math.max(newest, Date.parse(mr.updatedAt));
        changes.push(this.toSweptChange(mr));
      }
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);
    // Never regresses: an empty sweep resumes where this one began.
    const minted = Math.max(resume ?? 0, newest - CURSOR_OVERLAP_MS);
    return {
      coverage: resume === undefined ? "open" : "since",
      changes: await Promise.all(changes),
      cursor: minted > 0 ? forgeCursor(String(minted)) : undefined,
    };
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    const out = await this.client.graphql(GET_MR, { path: this.project.path, iid: String(id) });
    const found = this.requireProject(GetMrSchema.parse(out).project).mergeRequest;
    if (found === null) {
      throw new UserError(`no merge request !${id} on ${this.locator}`);
    }
    return this.toChange(found);
  }

  async createChange(head: ChangeName, parent: ChangeName, title: string): Promise<ForgeChange> {
    // The creation response names the new MR; fetching by its iid —
    // never by head, which could race another MR on the same branch —
    // reuses the one query that maps an MR.
    const data = await this.client.post(`${this.api}/merge_requests`, {
      source_branch: head,
      target_branch: parent,
      title,
    });
    return this.getChange(forgeChangeId(z.object({ iid: z.number() }).parse(data).iid));
  }

  async setParent(id: ForgeChangeId, parent: ChangeName): Promise<void> {
    await this.client.put(`${this.api}/merge_requests/${id}`, { target_branch: parent });
  }

  async setState(id: ForgeChangeId, state: "open" | "closed"): Promise<void> {
    await this.client.put(`${this.api}/merge_requests/${id}`, {
      state_event: state === "closed" ? "close" : "reopen",
    });
  }

  async setDraft(id: ForgeChangeId, draft: boolean): Promise<void> {
    // The mutation edits the title's draft prefix in place, so the title
    // itself never needs rewriting here.
    const out = await this.client.graphql(
      "mutation ($path: ID!, $iid: String!, $draft: Boolean!) { mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: $draft }) { errors } }",
      { path: this.project.path, iid: String(id), draft },
    );
    const { errors } = z
      .object({ mergeRequestSetDraft: z.object({ errors: z.array(z.string()) }).nullable() })
      .parse(out).mergeRequestSetDraft ?? { errors: [`no merge request !${id} on ${this.locator}`] };
    if (errors.length > 0) {
      throw new UserError(`${this.locator}!${id} draft not updated: ${errors.join("; ")}`);
    }
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    tip: Revision,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    // GitLab takes whole commit messages, not a title/body split. Squashing
    // under the merge-commit method writes a squash commit and a merge
    // commit; the same message goes on both, so the land trailer rides
    // whichever ends up on the target's first-parent chain.
    const full = `${title}\n\n${message}`;
    let data: unknown;
    try {
      data = await this.client.put(`${this.api}/merge_requests/${id}/merge`, {
        squash: method === "squash",
        merge_commit_message: full,
        squash_commit_message: full,
        // GitLab merges only while the head still matches, closing the race
        // between the caller's validation and this call.
        sha: tip,
      });
    } catch (error) {
      // 409 is a head that moved since `tip` was validated; 405 and 422 are
      // GitLab refusing the merge as such — an unmet approval or pipeline
      // rule, or an MR that does not merge cleanly. All are the user's to
      // resolve, and GitLab's message says which it was.
      if (isStatus(error, 405) || isStatus(error, 409) || isStatus(error, 422)) {
        throw new UserError(`${this.locator}!${id} did not merge: ${(error as Error).message}`);
      }
      throw error;
    }
    // GitLab has no per-MR merge method: the project's merge settings
    // may squash, rebase, or fast-forward whatever was asked, so the shape
    // is read off the landed commit rather than trusted from `method`.
    return this.landingShape(landedCommit(MergedMrSchema.parse(data)), tip);
  }

  async listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]> {
    // sort=asc lists creation order, oldest first, as the interface
    // promises. System notes — retargets, approvals, GitLab's own narration
    // of the MR — are not comments.
    const data = await this.client.getPaginated(`${this.api}/merge_requests/${id}/notes`, { sort: "asc" });
    return z
      .array(NoteSchema)
      .parse(data)
      .filter((note) => !note.system)
      .map(this.toComment, this);
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    await this.client.post(`${this.api}/merge_requests/${id}/notes`, { body });
  }

  async updateComment(id: ForgeChangeId, comment: string, body: string): Promise<void> {
    await this.client.put(`${this.api}/merge_requests/${id}/notes/${comment}`, { body });
  }

  async setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void> {
    // GitLab has no add/remove calls: the PUT replaces the whole reviewer
    // list, so the MR's current one is read first and edited.
    const { reviewers } = ReviewersSchema.parse(await this.client.get(`${this.api}/merge_requests/${id}`));
    const current = new Set(reviewers.map((reviewer) => reviewer.id));
    const wanted = new Set(current);
    for (const account of await Promise.all(remove.map(this.accountId, this))) {
      wanted.delete(account);
    }
    for (const account of await Promise.all(add.map(this.accountId, this))) {
      wanted.add(account);
    }
    if (wanted.size === current.size && [...wanted].every((account) => current.has(account))) {
      return;
    }
    await this.client.put(`${this.api}/merge_requests/${id}`, { reviewer_ids: [...wanted].sort((a, b) => a - b) });
  }
}

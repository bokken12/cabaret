import {
  type CommitHash,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  forgeChangeId,
  type LandMethod,
  type OpenChange,
  parseCommitHash,
  parseForgeLocator,
  parseRefName,
  type RefName,
  timestampMs,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { z } from "zod";
import { type GitLabClient, type GitLabProject, isStatus } from "./client.js";

/**
 * The identity for a username whose profile shows no public email: GitLab's
 * private-commit-email convention, which prefixes the numeric user id. An
 * account that cannot be looked up has no id and gets the bare form.
 */
function noreplyUser(id: string | undefined, username: string): UserName {
  return userName(`${id === undefined ? "" : `${id}-`}${username}@users.noreply.gitlab.com`);
}

// GitLab reattributes a deleted account's contributions to a per-instance
// "ghost" user, so an authorless MR is nearly unreachable — but the API
// admits one, and this fixed identity keeps the mapping total.
const GHOST = noreplyUser(undefined, "ghost");

// Inverts `noreplyUser`: the id-prefixed form names its account outright; the
// bare form still carries a username to look up.
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
  "iid sourceBranch diffHeadSha targetBranch title author { username } state mergeCommitSha reviewers(first: 100) { nodes { username } }";

const MrSchema = z.object({
  // GraphQL serializes the iid as a string.
  iid: z.string().transform((raw) => forgeChangeId(Number(raw))),
  sourceBranch: z.string().transform(parseRefName),
  diffHeadSha: z.string().transform(parseCommitHash),
  targetBranch: z.string().transform(parseRefName),
  title: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  mergeCommitSha: z.string().transform(parseCommitHash).nullable(),
  reviewers: z.object({ nodes: z.array(z.object({ username: z.string() })) }).nullable(),
});

const FIND_MR = `query ($path: ID!, $branch: String!) {
  project(fullPath: $path) {
    mergeRequests(sourceBranches: [$branch], state: opened, first: 1) { nodes { ${MR_FIELDS} } }
  }
}`;

// Notes are capped at the first hundred per MR rather than paginated,
// keeping the whole sweep to one query per hundred open MRs; the page info
// reports the cap so readers needing more fall back to `listComments`.
const OPEN_CHANGE_FIELDS = `${MR_FIELDS} notes(first: 100) { nodes { id author { username } body system updatedAt } pageInfo { hasNextPage } }`;

const FETCH_OPEN_CHANGES = `query ($path: ID!, $cursor: String) {
  project(fullPath: $path) {
    mergeRequests(state: opened, first: 100, after: $cursor) {
      nodes { ${OPEN_CHANGE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const GET_MR = `query ($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) { ${MR_FIELDS} }
  }
}`;

const USER = "query ($username: String!) { user(username: $username) { id publicEmail } }";

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

const OpenMrSchema = MrSchema.extend({
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

const FetchOpenChangesSchema = z.object({
  project: z
    .object({
      mergeRequests: z.object({
        nodes: z.array(OpenMrSchema),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    })
    .nullable(),
});

const GetMrSchema = z.object({
  project: z.object({ mergeRequest: MrSchema.nullable() }).nullable(),
});

const UserSchema = z.object({
  user: z.object({ id: z.string(), publicEmail: z.string().nullable() }).nullable(),
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
function landedCommit(mr: z.infer<typeof MergedMrSchema>): CommitHash {
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

const UserSearchSchema = z.array(z.object({ id: z.number() }));

/** A `Forge` for a gitlab.com project, speaking the API directly. */
export class GitLabForge implements Forge {
  private readonly identities = new Map<string, Promise<UserName>>();
  private readonly accounts = new Map<UserName, Promise<number>>();
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

  /**
   * The Cabaret identity for `username`: the account's public profile email
   * when it shows one, else GitLab's noreply convention. One API call per
   * username; only a success is cached, so a transient failure cannot pin a
   * wrong identity for the forge's lifetime.
   */
  private identity(username: string): Promise<UserName> {
    let pending = this.identities.get(username);
    if (pending === undefined) {
      pending = this.client
        .graphql(USER, { username })
        .then((out) => {
          const user = UserSchema.parse(out).user;
          if (user === null) {
            return noreplyUser(undefined, username);
          }
          if (user.publicEmail !== null && user.publicEmail !== "") {
            return userName(user.publicEmail);
          }
          return noreplyUser(userIdOfGid(user.id), username);
        })
        .catch((error: unknown) => {
          this.identities.delete(username);
          throw error;
        });
      this.identities.set(username, pending);
    }
    return pending;
  }

  /**
   * The numeric user id behind a Cabaret identity — `identity` in reverse. An
   * id-prefixed noreply name carries its id outright; a bare one still names
   * a username to look up; anything else is searched as a public email, which
   * GitLab matches exactly. As with `identity`, only a success is cached.
   */
  private accountId(user: UserName): Promise<number> {
    let pending = this.accounts.get(user);
    if (pending === undefined) {
      pending = this.lookupAccountId(user).catch((error: unknown) => {
        this.accounts.delete(user);
        throw error;
      });
      this.accounts.set(user, pending);
    }
    return pending;
  }

  private async lookupAccountId(user: UserName): Promise<number> {
    const [, id, username] = NOREPLY.exec(user) ?? [];
    if (id !== undefined) {
      return Number(id);
    }
    if (username !== undefined) {
      const found = UserSchema.parse(await this.client.graphql(USER, { username })).user;
      if (found === null) {
        throw new UserError(`no gitlab.com account found for "${user}"`);
      }
      return Number(userIdOfGid(found.id));
    }
    const matches = UserSearchSchema.parse(await this.client.get("/users", { search: user }));
    const match = matches[0];
    if (match === undefined) {
      throw new UserError(`no gitlab.com account found for "${user}"`);
    }
    if (matches.length > 1) {
      throw new UserError(`"${user}" is ambiguous on gitlab.com`);
    }
    return match.id;
  }

  private async toChange(mr: z.infer<typeof MrSchema>): Promise<ForgeChange> {
    return {
      id: mr.iid,
      head: mr.sourceBranch,
      tip: mr.diffHeadSha,
      parent: mr.targetBranch,
      title: mr.title,
      author: mr.author === null ? GHOST : await this.identity(mr.author.username),
      // A locked MR is mid-merge on the server; until that lands it has
      // not merged, so it reads as open.
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      // Sorted by identity: the forge promises no order of its own.
      reviewers: (
        await Promise.all((mr.reviewers?.nodes ?? []).map((reviewer) => this.identity(reviewer.username)))
      ).sort(),
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
  private async landingShape(commit: CommitHash, tip: CommitHash): Promise<ForgeMerge> {
    const { parent_ids } = CommitSchema.parse(await this.client.get(`${this.api}/repository/commits/${commit}`));
    return { commit, parents: parent_ids.length === 2 && parent_ids[1] === tip ? 2 : 1 };
  }

  private async toComment(note: z.infer<typeof NoteSchema>): Promise<ForgeComment> {
    return {
      id: String(note.id),
      author: await this.identity(note.author.username),
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

  async findChange(branch: RefName): Promise<ForgeChange | undefined> {
    const out = await this.client.graphql(FIND_MR, { path: this.project.path, branch });
    const found = this.requireProject(FindMrSchema.parse(out).project).mergeRequests.nodes[0];
    return found === undefined ? undefined : this.toChange(found);
  }

  private async toOpenChange(mr: z.infer<typeof OpenMrSchema>): Promise<OpenChange> {
    const change = await this.toChange(mr);
    const comments = await Promise.all(
      mr.notes.nodes
        .filter((note) => !note.system)
        .map(async (note) => {
          const id = NOTE_GID.exec(note.id)?.[1];
          // A gid in any other shape must not silently desynchronize these
          // note identities from REST's.
          if (id === undefined) {
            throw new Error(`unexpected note id format: ${note.id}`);
          }
          return {
            id,
            author: note.author === null ? GHOST : await this.identity(note.author.username),
            body: note.body,
            updatedAt: timestampMs(Date.parse(note.updatedAt)),
          };
        }),
    );
    // System notes are filtered after the cap, so a capped page may over-
    // report truncation; the fallback just re-lists what was already whole.
    return { change, comments, commentsTruncated: mr.notes.pageInfo.hasNextPage };
  }

  async fetchOpenChanges(): Promise<readonly OpenChange[]> {
    const changes: Promise<OpenChange>[] = [];
    let cursor: string | null = null;
    do {
      const out: unknown = await this.client.graphql(FETCH_OPEN_CHANGES, { path: this.project.path, cursor });
      const { nodes, pageInfo } = this.requireProject(FetchOpenChangesSchema.parse(out).project).mergeRequests;
      changes.push(...nodes.map(this.toOpenChange, this));
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);
    return Promise.all(changes);
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    const out = await this.client.graphql(GET_MR, { path: this.project.path, iid: String(id) });
    const found = this.requireProject(GetMrSchema.parse(out).project).mergeRequest;
    if (found === null) {
      throw new UserError(`no merge request !${id} on ${this.locator}`);
    }
    return this.toChange(found);
  }

  async createChange(head: RefName, parent: RefName, title: string): Promise<ForgeChange> {
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

  async setParent(id: ForgeChangeId, parent: RefName): Promise<void> {
    await this.client.put(`${this.api}/merge_requests/${id}`, { target_branch: parent });
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    tip: CommitHash,
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
    const notes = z
      .array(NoteSchema)
      .parse(data)
      .filter((note) => !note.system);
    return Promise.all(notes.map(this.toComment, this));
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    await this.client.post(`${this.api}/merge_requests/${id}/notes`, { body });
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

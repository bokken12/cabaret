import {
  type CommitHash,
  type FilePath,
  type Forge,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  type ForgeRequest,
  type ForgeRequestId,
  forgeRequestId,
  type LandMethod,
  parseCommitHash,
  parseFilePath,
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
// "ghost" user, so an authorless request is nearly unreachable — but the API
// admits one, and this fixed identity keeps the mapping total.
const GHOST = noreplyUser(undefined, "ghost");

// The request fields every query selects. GraphQL rather than REST because
// the queries need a changed-file count, which REST carries only on a single
// fetched request — and there as a string capped at "1000+".
const MR_FIELDS =
  "iid sourceBranch diffHeadSha targetBranch title author { username } state " +
  "mergeCommitSha diffStatsSummary { fileCount }";

const MrSchema = z.object({
  // GraphQL serializes the iid as a string.
  iid: z.string().transform((raw) => forgeRequestId(Number(raw))),
  sourceBranch: z.string().transform(parseRefName),
  diffHeadSha: z.string().transform(parseCommitHash),
  targetBranch: z.string().transform(parseRefName),
  title: z.string(),
  author: z.object({ username: z.string() }).nullable(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  mergeCommitSha: z.string().transform(parseCommitHash).nullable(),
  diffStatsSummary: z.object({ fileCount: z.number() }),
});

const FIND_REQUEST = `query ($path: ID!, $branch: String!) {
  project(fullPath: $path) {
    mergeRequests(sourceBranches: [$branch], state: opened, first: 1) { nodes { ${MR_FIELDS} } }
  }
}`;

const LIST_OPEN_REQUESTS = `query ($path: ID!, $cursor: String) {
  project(fullPath: $path) {
    mergeRequests(state: opened, first: 100, after: $cursor) {
      nodes { ${MR_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const GET_REQUEST = `query ($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) { ${MR_FIELDS} }
  }
}`;

const USER = "query ($username: String!) { user(username: $username) { id publicEmail } }";

// GitLab's GraphQL nulls a missing or unauthorized record instead of
// erroring, so every query's schema admits the null and absence is raised as
// a `UserError` naming what was asked for.
const FindRequestSchema = z.object({
  project: z.object({ mergeRequests: z.object({ nodes: z.array(MrSchema) }) }).nullable(),
});

const ListOpenRequestsSchema = z.object({
  project: z
    .object({
      mergeRequests: z.object({
        nodes: z.array(MrSchema),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    })
    .nullable(),
});

const GetRequestSchema = z.object({
  project: z.object({ mergeRequest: MrSchema.nullable() }).nullable(),
});

const UserSchema = z.object({
  user: z.object({ id: z.string(), publicEmail: z.string().nullable() }).nullable(),
});

// The merged-commit fields of a REST merge-request object: what the merge
// call returns, and what a merged request is re-fetched for, since GraphQL
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

/** A `Forge` for a gitlab.com project, speaking the API directly. */
export class GitLabForge implements Forge {
  private readonly identities = new Map<string, Promise<UserName>>();
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
          const id = /^gid:\/\/gitlab\/User\/(\d+)$/.exec(user.id)?.[1];
          // A gid in any other shape must not silently change the identity's
          // spelling across versions.
          if (id === undefined) {
            throw new Error(`unexpected user id format: ${user.id}`);
          }
          return noreplyUser(id, username);
        })
        .catch((error: unknown) => {
          this.identities.delete(username);
          throw error;
        });
      this.identities.set(username, pending);
    }
    return pending;
  }

  private async toRequest(mr: z.infer<typeof MrSchema>): Promise<ForgeRequest> {
    return {
      id: mr.iid,
      head: mr.sourceBranch,
      tip: mr.diffHeadSha,
      base: mr.targetBranch,
      title: mr.title,
      author: mr.author === null ? GHOST : await this.identity(mr.author.username),
      // A locked request is mid-merge on the server; until that lands it has
      // not merged, so it reads as open.
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      changedFiles: mr.diffStatsSummary.fileCount,
      ...(mr.state === "merged" ? { merge: await this.mergeOf(mr) } : {}),
    };
  }

  private async mergeOf(mr: z.infer<typeof MrSchema>): Promise<ForgeMerge> {
    // A merge without a merge commit landed something GraphQL never exposes —
    // the squash commit, or a fast-forward of the head itself — so only that
    // case re-fetches the request over REST.
    const commit =
      mr.mergeCommitSha ??
      landedCommit(MergedMrSchema.parse(await this.client.get(`${this.api}/merge_requests/${mr.iid}`)));
    return this.landingShape(commit, mr.diffHeadSha);
  }

  /**
   * How `commit` landed a request whose reviewed head was `tip`. GitLab's
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

  async findRequest(branch: RefName): Promise<ForgeRequest | undefined> {
    const out = await this.client.graphql(FIND_REQUEST, { path: this.project.path, branch });
    const found = this.requireProject(FindRequestSchema.parse(out).project).mergeRequests.nodes[0];
    return found === undefined ? undefined : this.toRequest(found);
  }

  async listOpenRequests(): Promise<readonly ForgeRequest[]> {
    const requests: Promise<ForgeRequest>[] = [];
    let cursor: string | null = null;
    do {
      const out: unknown = await this.client.graphql(LIST_OPEN_REQUESTS, { path: this.project.path, cursor });
      const { nodes, pageInfo } = this.requireProject(ListOpenRequestsSchema.parse(out).project).mergeRequests;
      requests.push(...nodes.map(this.toRequest, this));
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);
    return Promise.all(requests);
  }

  async getRequest(id: ForgeRequestId): Promise<ForgeRequest> {
    const out = await this.client.graphql(GET_REQUEST, { path: this.project.path, iid: String(id) });
    const found = this.requireProject(GetRequestSchema.parse(out).project).mergeRequest;
    if (found === null) {
      throw new UserError(`no merge request !${id} on ${this.locator}`);
    }
    return this.toRequest(found);
  }

  async createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest> {
    // The creation response names the new request; fetching by its iid —
    // never by head, which could race another request on the same branch —
    // reuses the one query that maps a request.
    const data = await this.client.post(`${this.api}/merge_requests`, {
      source_branch: head,
      target_branch: base,
      title,
    });
    return this.getRequest(forgeRequestId(z.object({ iid: z.number() }).parse(data).iid));
  }

  async setBase(id: ForgeRequestId, base: RefName): Promise<void> {
    await this.client.put(`${this.api}/merge_requests/${id}`, { target_branch: base });
  }

  async mergeRequest(
    id: ForgeRequestId,
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
      // rule, or a request that does not merge cleanly. All are the user's to
      // resolve, and GitLab's message says which it was.
      if (isStatus(error, 405) || isStatus(error, 409) || isStatus(error, 422)) {
        throw new UserError(`${this.locator}!${id} did not merge: ${(error as Error).message}`);
      }
      throw error;
    }
    // GitLab has no per-request merge method: the project's merge settings
    // may squash, rebase, or fast-forward whatever was asked, so the shape
    // is read off the landed commit rather than trusted from `method`.
    return this.landingShape(landedCommit(MergedMrSchema.parse(data)), tip);
  }

  async listFiles(id: ForgeRequestId): Promise<readonly FilePath[]> {
    // A renamed file lists under its new path (which for a deletion still
    // names the deleted file).
    const data = await this.client.getPaginated(`${this.api}/merge_requests/${id}/diffs`);
    return z
      .array(z.object({ new_path: z.string() }))
      .parse(data)
      .map(({ new_path }) => parseFilePath(new_path));
  }

  async listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]> {
    // sort=asc lists creation order, oldest first, as the interface
    // promises. System notes — retargets, approvals, GitLab's own narration
    // of the request — are not comments.
    const data = await this.client.getPaginated(`${this.api}/merge_requests/${id}/notes`, { sort: "asc" });
    const notes = z
      .array(NoteSchema)
      .parse(data)
      .filter((note) => !note.system);
    return Promise.all(notes.map(this.toComment, this));
  }

  async addComment(id: ForgeRequestId, body: string): Promise<void> {
    await this.client.post(`${this.api}/merge_requests/${id}/notes`, { body });
  }
}

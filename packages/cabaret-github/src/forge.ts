import {
  type FilePath,
  type Forge,
  type ForgeComment,
  type ForgeLocator,
  type ForgeRequest,
  type ForgeRequestId,
  forgeRequestId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  type RefName,
  timestampMs,
  type UserName,
  userName,
} from "cabaret-core";
import { z } from "zod";
import type { GitHubClient, GitHubRepo } from "./client.js";

/** The identity for a login whose profile shows no email: GitHub's own noreply convention. */
function noreplyUser(login: string): UserName {
  return userName(`${login}@users.noreply.github.com`);
}

// The request fields every query selects. GraphQL rather than REST because
// the list queries need `changedFiles`, which REST includes only on a single
// fetched request — per-request follow-ups would make listing N+1.
const PR_FIELDS = "number headRefName baseRefName title author { login } state mergeCommit { oid } changedFiles";

const PrSchema = z.object({
  number: z.number().transform(forgeRequestId),
  headRefName: z.string().transform(parseRefName),
  baseRefName: z.string().transform(parseRefName),
  title: z.string(),
  // A deleted account's request has no author; REST's "ghost" stands in.
  author: z.object({ login: z.string() }).nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: z.object({ oid: z.string().transform(parseCommitHash) }).nullable(),
  changedFiles: z.number(),
});

const FIND_REQUEST = `query ($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, states: OPEN, first: 1) { nodes { ${PR_FIELDS} } }
  }
}`;

const LIST_OPEN_REQUESTS = `query ($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      nodes { ${PR_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const GET_REQUEST = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { ${PR_FIELDS} }
  }
}`;

const FindRequestSchema = z.object({
  repository: z.object({ pullRequests: z.object({ nodes: z.array(PrSchema) }) }),
});

const ListOpenRequestsSchema = z.object({
  repository: z.object({
    pullRequests: z.object({
      nodes: z.array(PrSchema),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});

const GetRequestSchema = z.object({
  repository: z.object({ pullRequest: PrSchema }),
});

const IssueCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  updated_at: z.string(),
});

/** A `Forge` for a github.com repository, speaking the API directly. */
export class GitHubForge implements Forge {
  private readonly identities = new Map<string, Promise<UserName>>();
  readonly locator: ForgeLocator;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: GitHubRepo,
  ) {
    this.locator = parseForgeLocator(`github.com/${repo.owner}/${repo.repo}`);
  }

  /**
   * The Cabaret identity for `login`: the account's public profile email when
   * it shows one, else GitHub's noreply convention. One API call per login,
   * cached for this forge's lifetime.
   */
  private identity(login: string): Promise<UserName> {
    let pending = this.identities.get(login);
    if (pending === undefined) {
      pending = this.client
        .request("GET /users/{username}", { username: login })
        .then(({ data }) => {
          const { email } = z.object({ email: z.string().nullable() }).parse(data);
          return email === null || email === "" ? noreplyUser(login) : userName(email);
        })
        // Deleted accounts 404; their requests and comments still need an identity.
        .catch(() => noreplyUser(login));
      this.identities.set(login, pending);
    }
    return pending;
  }

  private async toRequest(pr: z.infer<typeof PrSchema>): Promise<ForgeRequest> {
    return {
      id: pr.number,
      head: pr.headRefName,
      base: pr.baseRefName,
      title: pr.title,
      author: await this.identity(pr.author?.login ?? "ghost"),
      state: pr.state === "OPEN" ? "open" : pr.state === "CLOSED" ? "closed" : "merged",
      changedFiles: pr.changedFiles,
      ...(pr.mergeCommit === null ? {} : { merge: pr.mergeCommit.oid }),
    };
  }

  private async toComment(comment: z.infer<typeof IssueCommentSchema>): Promise<ForgeComment> {
    return {
      id: String(comment.id),
      author: await this.identity(comment.user.login),
      body: comment.body,
      updatedAt: timestampMs(Date.parse(comment.updated_at)),
    };
  }

  async findRequest(branch: RefName): Promise<ForgeRequest | undefined> {
    const out = await this.client.graphql(FIND_REQUEST, { ...this.repo, branch });
    const found = FindRequestSchema.parse(out).repository.pullRequests.nodes[0];
    return found === undefined ? undefined : this.toRequest(found);
  }

  async listOpenRequests(): Promise<readonly ForgeRequest[]> {
    const requests: Promise<ForgeRequest>[] = [];
    let cursor: string | null = null;
    do {
      const out: unknown = await this.client.graphql(LIST_OPEN_REQUESTS, { ...this.repo, cursor });
      const { nodes, pageInfo } = ListOpenRequestsSchema.parse(out).repository.pullRequests;
      requests.push(...nodes.map(this.toRequest, this));
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);
    return Promise.all(requests);
  }

  async getRequest(id: ForgeRequestId): Promise<ForgeRequest> {
    const out = await this.client.graphql(GET_REQUEST, { ...this.repo, number: id });
    return this.toRequest(GetRequestSchema.parse(out).repository.pullRequest);
  }

  async createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest> {
    // The creation response names the new request; fetching by its number —
    // never by head, which could race another request on the same branch —
    // reuses the one query that maps a request.
    const { data } = await this.client.request("POST /repos/{owner}/{repo}/pulls", {
      ...this.repo,
      title,
      head,
      base,
      body: "",
    });
    return this.getRequest(forgeRequestId(z.object({ number: z.number() }).parse(data).number));
  }

  async setBase(id: ForgeRequestId, base: RefName): Promise<void> {
    await this.client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...this.repo,
      pull_number: id,
      base,
    });
  }

  async listFiles(id: ForgeRequestId): Promise<readonly FilePath[]> {
    // A renamed file lists under its new path.
    const data = await this.client.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      ...this.repo,
      pull_number: id,
      per_page: 100,
    });
    return z
      .array(z.object({ filename: z.string() }))
      .parse(data)
      .map(({ filename }) => parseFilePath(filename));
  }

  async listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]> {
    // GitHub returns issue comments in creation order — oldest first, as the
    // interface promises — and paginate walks every page.
    const data = await this.client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...this.repo,
      issue_number: id,
      per_page: 100,
    });
    return Promise.all(z.array(IssueCommentSchema).parse(data).map(this.toComment, this));
  }

  async addComment(id: ForgeRequestId, body: string): Promise<void> {
    await this.client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...this.repo,
      issue_number: id,
      body,
    });
  }
}

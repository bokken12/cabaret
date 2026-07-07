import {
  type CommitHash,
  type Forge,
  type ForgeComment,
  type ForgeRequest,
  type ForgeRequestId,
  forgeRequestId,
  parseForgeLocator,
  type RefName,
  timestampMs,
  userName,
} from "cabaret-core";

interface FakeComment {
  readonly id: string;
  readonly login: string;
  body: string;
  updatedAt: number;
}

interface FakeRequest {
  readonly head: RefName;
  base: RefName;
  readonly title: string;
  readonly login: string;
  state: "open" | "closed" | "merged";
  merge?: CommitHash;
  readonly changedFiles: number;
  readonly comments: FakeComment[];
}

/**
 * An in-memory `Forge` for e2e tests, with hooks acting as the forge-side
 * teammate: posting, editing, and merging. Its clock is its own — forge
 * timestamps come from the forge — and ticks one millisecond per event.
 */
export class FakeForge implements Forge {
  readonly locator = parseForgeLocator("github.com/test-org/widgets");
  /** The login the CLI's own posts arrive under, as the token's owner. */
  tokenLogin = "alice";
  private readonly requests = new Map<ForgeRequestId, FakeRequest>();
  private clock = 1750000000000;
  private nextComment = 100;

  async findRequest(branch: RefName): Promise<ForgeRequest | undefined> {
    for (const [id, request] of this.requests) {
      if (request.head === branch && request.state === "open") {
        return this.snapshot(id, request);
      }
    }
    return undefined;
  }

  async listOpenRequests(): Promise<readonly ForgeRequest[]> {
    return [...this.requests]
      .filter(([, request]) => request.state === "open")
      .map(([id, request]) => this.snapshot(id, request));
  }

  async getRequest(id: ForgeRequestId): Promise<ForgeRequest> {
    return this.snapshot(id, this.request(id));
  }

  async createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest> {
    return this.getRequest(this.openRequest(this.tokenLogin, head, base, title));
  }

  async setBase(id: ForgeRequestId, base: RefName): Promise<void> {
    this.request(id).base = base;
  }

  async listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]> {
    return this.request(id).comments.map((comment) => ({
      id: comment.id,
      author: userName(`${comment.login}@users.noreply.github.com`),
      body: comment.body,
      updatedAt: timestampMs(comment.updatedAt),
    }));
  }

  async addComment(id: ForgeRequestId, body: string): Promise<void> {
    this.comment(id, this.tokenLogin, body);
  }

  /** A request opened on the forge by `login`; returns its number. */
  openRequest(login: string, head: RefName, base: RefName, title: string, changedFiles = 1): ForgeRequestId {
    const id = forgeRequestId(this.requests.size + 1);
    this.requests.set(id, { head, base, title, login, state: "open", changedFiles, comments: [] });
    return id;
  }

  /** A comment posted on the forge by `login`; returns its id. */
  comment(id: ForgeRequestId, login: string, body: string): string {
    const commentId = String(this.nextComment++);
    this.request(id).comments.push({ id: commentId, login, body, updatedAt: this.clock++ });
    return commentId;
  }

  /** Edit comment `commentId` in place, as the forge does. */
  edit(id: ForgeRequestId, commentId: string, body: string): void {
    const comment = this.request(id).comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) {
      throw new Error(`no comment ${commentId} on request ${id}`);
    }
    comment.body = body;
    comment.updatedAt = this.clock++;
  }

  /** The merge button. */
  merge(id: ForgeRequestId, mergeCommit: CommitHash): void {
    const request = this.request(id);
    request.state = "merged";
    request.merge = mergeCommit;
  }

  private request(id: ForgeRequestId): FakeRequest {
    const request = this.requests.get(id);
    if (request === undefined) {
      throw new Error(`no request ${id}`);
    }
    return request;
  }

  private snapshot(id: ForgeRequestId, request: FakeRequest): ForgeRequest {
    return {
      id,
      head: request.head,
      base: request.base,
      title: request.title,
      author: userName(`${request.login}@users.noreply.github.com`),
      state: request.state,
      changedFiles: request.changedFiles,
      ...(request.merge === undefined ? {} : { merge: request.merge }),
    };
  }
}

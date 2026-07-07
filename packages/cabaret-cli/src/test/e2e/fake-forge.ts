import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type CommitHash,
  type FilePath,
  type Forge,
  type ForgeComment,
  type ForgeMerge,
  type ForgeRequest,
  type ForgeRequestId,
  forgeRequestId,
  type LandMethod,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  type RefName,
  timestampMs,
  userName,
} from "cabaret-core";

const execFileAsync = promisify(execFile);

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
  merge?: ForgeMerge;
  /** The head that merged; the live branch tip until then. */
  tip?: CommitHash;
  readonly files: readonly FilePath[];
  readonly comments: FakeComment[];
}

/**
 * An in-memory `Forge` for e2e tests, with hooks acting as the forge-side
 * teammate: posting, editing, and merging. It hosts the same bare repository
 * the test repo's `origin` names, as GitHub hosts the repository it fronts;
 * `makeRepo` wires it. Its clock is its own — forge timestamps come from the
 * forge — and ticks one millisecond per event.
 */
export class FakeForge implements Forge {
  readonly locator = parseForgeLocator("github.com/test-org/widgets");
  /** The login the CLI's own posts arrive under, as the token's owner. */
  tokenLogin = "alice";
  /** The bare repository this forge hosts; `makeRepo` sets it. */
  origin: string | undefined;
  private readonly requests = new Map<ForgeRequestId, FakeRequest>();
  private clock = 1750000000000;
  private nextComment = 100;

  private async git(...args: string[]): Promise<string> {
    if (this.origin === undefined) {
      throw new Error("this forge hosts no repository; create it with makeRepo");
    }
    const { stdout } = await execFileAsync("git", args, { cwd: this.origin });
    return stdout.trimEnd();
  }

  /**
   * The commit `branch` points at on the hosted repository. A real forge
   * cannot host a request for a branch it does not have, but tests fabricate
   * them; the zero hash stands in, and never matches a real local tip.
   */
  private async branchTip(branch: RefName): Promise<CommitHash> {
    try {
      return parseCommitHash(await this.git("rev-parse", "--verify", `refs/heads/${branch}`));
    } catch {
      return parseCommitHash("0".repeat(40));
    }
  }

  async findRequest(branch: RefName): Promise<ForgeRequest | undefined> {
    for (const [id, request] of this.requests) {
      if (request.head === branch && request.state === "open") {
        return this.snapshot(id, request);
      }
    }
    return undefined;
  }

  async listOpenRequests(): Promise<readonly ForgeRequest[]> {
    return Promise.all(
      [...this.requests]
        .filter(([, request]) => request.state === "open")
        .map(([id, request]) => this.snapshot(id, request)),
    );
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

  async mergeRequest(
    id: ForgeRequestId,
    method: LandMethod,
    expectedTip: CommitHash,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    const request = this.request(id);
    if (request.state !== "open") {
      throw new Error(`request ${id} is ${request.state}`);
    }
    const onto = await this.branchTip(request.base);
    const tip = await this.branchTip(request.head);
    if (tip !== expectedTip) {
      throw new Error(`request ${id} head is at ${tip}, not ${expectedTip}`);
    }
    const tree = await this.git("rev-parse", `${tip}^{tree}`);
    const parents = method === "merge" ? ["-p", onto, "-p", tip] : ["-p", onto];
    // GitHub composes the commit message as the title, a blank line, and the body.
    const commit = parseCommitHash(await this.git("commit-tree", tree, "-m", `${title}\n\n${message}`, ...parents));
    await this.git("update-ref", `refs/heads/${request.base}`, commit, onto);
    request.state = "merged";
    request.merge = { commit, parents: method === "merge" ? 2 : 1 };
    request.tip = tip;
    return request.merge;
  }

  async listFiles(id: ForgeRequestId): Promise<readonly FilePath[]> {
    return this.request(id).files;
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
  openRequest(login: string, head: RefName, base: RefName, title: string, files = ["work.txt"]): ForgeRequestId {
    const id = forgeRequestId(this.requests.size + 1);
    this.requests.set(id, { head, base, title, login, state: "open", files: files.map(parseFilePath), comments: [] });
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

  /** The merge button, pressed after `mergeCommit` reached the base branch out of band. */
  merge(id: ForgeRequestId, mergeCommit: CommitHash, parents = 2): void {
    const request = this.request(id);
    request.state = "merged";
    request.merge = { commit: mergeCommit, parents };
  }

  private request(id: ForgeRequestId): FakeRequest {
    const request = this.requests.get(id);
    if (request === undefined) {
      throw new Error(`no request ${id}`);
    }
    return request;
  }

  private async snapshot(id: ForgeRequestId, request: FakeRequest): Promise<ForgeRequest> {
    return {
      id,
      head: request.head,
      tip: request.tip ?? (await this.branchTip(request.head)),
      base: request.base,
      title: request.title,
      author: userName(`${request.login}@users.noreply.github.com`),
      state: request.state,
      changedFiles: request.files.length,
      ...(request.merge === undefined ? {} : { merge: request.merge }),
    };
  }
}

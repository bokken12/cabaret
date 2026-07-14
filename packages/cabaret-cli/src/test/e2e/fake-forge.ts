import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type CommitHash,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeMerge,
  forgeChangeId,
  type LandMethod,
  type OpenChange,
  parseCommitHash,
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

interface FakePr {
  readonly head: RefName;
  base: RefName;
  readonly title: string;
  readonly login: string;
  state: "open" | "closed" | "merged";
  merge?: ForgeMerge;
  /** The head that merged; the live branch tip until then. */
  tip?: CommitHash;
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
  /** When set, `fetchOpenChanges` caps each change's comments at this many, as real forges do. */
  commentCap: number | undefined;
  private readonly prs = new Map<ForgeChangeId, FakePr>();
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
   * cannot host a PR for a branch it does not have, but tests fabricate
   * them; the zero hash stands in, and never matches a real local tip.
   */
  private async branchTip(branch: RefName): Promise<CommitHash> {
    try {
      return parseCommitHash(await this.git("rev-parse", "--verify", `refs/heads/${branch}`));
    } catch {
      return parseCommitHash("0".repeat(40));
    }
  }

  async findChange(branch: RefName): Promise<ForgeChange | undefined> {
    for (const [id, pr] of this.prs) {
      if (pr.head === branch && pr.state === "open") {
        return this.toChange(id, pr);
      }
    }
    return undefined;
  }

  async fetchOpenChanges(): Promise<readonly OpenChange[]> {
    return Promise.all(
      [...this.prs]
        .filter(([, pr]) => pr.state === "open")
        .map(async ([id, pr]): Promise<OpenChange> => {
          const comments = await this.listComments(id);
          const capped = this.commentCap !== undefined && comments.length > this.commentCap;
          return {
            change: await this.toChange(id, pr),
            comments: capped ? comments.slice(0, this.commentCap) : comments,
            commentsTruncated: capped,
          };
        }),
    );
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    return this.toChange(id, this.pr(id));
  }

  async createChange(head: RefName, parent: RefName, title: string): Promise<ForgeChange> {
    return this.getChange(this.openPr(this.tokenLogin, head, parent, title));
  }

  async setParent(id: ForgeChangeId, parent: RefName): Promise<void> {
    this.pr(id).base = parent;
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    expectedTip: CommitHash,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    const pr = this.pr(id);
    if (pr.state !== "open") {
      throw new Error(`PR ${id} is ${pr.state}`);
    }
    const onto = await this.branchTip(pr.base);
    const tip = await this.branchTip(pr.head);
    if (tip !== expectedTip) {
      throw new Error(`PR ${id} head is at ${tip}, not ${expectedTip}`);
    }
    const tree = await this.git("rev-parse", `${tip}^{tree}`);
    const parents = method === "merge" ? ["-p", onto, "-p", tip] : ["-p", onto];
    // GitHub composes the commit message as the title, a blank line, and the body.
    const commit = parseCommitHash(await this.git("commit-tree", tree, "-m", `${title}\n\n${message}`, ...parents));
    await this.git("update-ref", `refs/heads/${pr.base}`, commit, onto);
    pr.state = "merged";
    pr.merge = { commit, parents: method === "merge" ? 2 : 1 };
    pr.tip = tip;
    return pr.merge;
  }

  async listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]> {
    return this.pr(id).comments.map((comment) => ({
      id: comment.id,
      author: userName(`${comment.login}@users.noreply.github.com`),
      body: comment.body,
      updatedAt: timestampMs(comment.updatedAt),
    }));
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    this.comment(id, this.tokenLogin, body);
  }

  /** A PR opened on the forge by `login`; returns its number. */
  openPr(login: string, head: RefName, base: RefName, title: string): ForgeChangeId {
    const id = forgeChangeId(this.prs.size + 1);
    this.prs.set(id, { head, base, title, login, state: "open", comments: [] });
    return id;
  }

  /** The close button: the PR is declined without merging. */
  close(id: ForgeChangeId): void {
    this.pr(id).state = "closed";
  }

  /** A comment posted on the forge by `login`; returns its id. */
  comment(id: ForgeChangeId, login: string, body: string): string {
    const commentId = String(this.nextComment++);
    this.pr(id).comments.push({ id: commentId, login, body, updatedAt: this.clock++ });
    return commentId;
  }

  /** Edit comment `commentId` in place, as the forge does. */
  edit(id: ForgeChangeId, commentId: string, body: string): void {
    const comment = this.pr(id).comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) {
      throw new Error(`no comment ${commentId} on PR ${id}`);
    }
    comment.body = body;
    comment.updatedAt = this.clock++;
  }

  /** The merge button, pressed after `mergeCommit` reached the base branch out of band. */
  merge(id: ForgeChangeId, mergeCommit: CommitHash, parents = 2): void {
    const pr = this.pr(id);
    pr.state = "merged";
    pr.merge = { commit: mergeCommit, parents };
  }

  private pr(id: ForgeChangeId): FakePr {
    const pr = this.prs.get(id);
    if (pr === undefined) {
      throw new Error(`no PR ${id}`);
    }
    return pr;
  }

  private async toChange(id: ForgeChangeId, pr: FakePr): Promise<ForgeChange> {
    return {
      id,
      head: pr.head,
      tip: pr.tip ?? (await this.branchTip(pr.head)),
      parent: pr.base,
      title: pr.title,
      author: userName(`${pr.login}@users.noreply.github.com`),
      state: pr.state,
      ...(pr.merge === undefined ? {} : { merge: pr.merge }),
    };
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ChangeName,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeCursor,
  type ForgeMerge,
  type ForgeSweep,
  forgeChangeId,
  forgeCursor,
  type LandMethod,
  parseCommitHash,
  parseForgeLocator,
  type Revision,
  type Self,
  type SweptChange,
  timestampMs,
  type UserName,
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
  readonly head: ChangeName;
  base: ChangeName;
  readonly title: string;
  readonly login: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  merge?: ForgeMerge;
  /** The head that merged; the live branch tip until then. */
  tip?: Revision;
  readonly comments: FakeComment[];
  /** Logins with a pending review request. */
  readonly requested: Set<string>;
  /** Logins that submitted a review; GitHub reports them as reviewers forever. */
  readonly reviewed: Set<string>;
  /** When the PR was last touched, as GitHub stamps `updated_at`: every mutation bumps it. */
  updated: number;
  /** The head commit the last sweep saw, so the next one notices a push as GitHub would. */
  seenTip?: Revision;
}

/** The identity every fake login maps to, as the real GitHub forge mints them. */
function loginIdentity(login: string): UserName {
  return userName(`github:${login}`);
}

/** Invert `loginIdentity`, as a real forge maps an identity back to an account. */
function identityLogin(user: string): string {
  const login = /^github:(.+)$/.exec(user)?.[1];
  if (login === undefined) {
    throw new Error(`no github.com account for ${JSON.stringify(user)}`);
  }
  return login;
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
  /** The public email the token's account shows, when it shows one. */
  tokenEmail: string | undefined;
  /** The bare repository this forge hosts; `makeRepo` sets it. */
  origin: string | undefined;
  /** When set, `fetchChanges` caps each change's comments at this many, as real forges do. */
  commentCap: number | undefined;
  private readonly prs = new Map<ForgeChangeId, FakePr>();
  private clock = 1750000000000;
  private nextComment = 100;

  /** Stamp `pr` touched now, as GitHub bumps `updated_at` on every mutation. */
  private touch(pr: FakePr): void {
    pr.updated = this.clock++;
  }

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
  private async tip(branch: ChangeName): Promise<Revision> {
    try {
      return parseCommitHash(await this.git("rev-parse", "--verify", `refs/heads/${branch}`));
    } catch {
      return parseCommitHash("0".repeat(40));
    }
  }

  async currentSelf(): Promise<Self> {
    const aliases = new Set<UserName>();
    if (this.tokenEmail !== undefined) {
      aliases.add(userName(this.tokenEmail));
    }
    return { user: loginIdentity(this.tokenLogin), aliases };
  }

  async findChange(branch: ChangeName): Promise<ForgeChange | undefined> {
    for (const [id, pr] of this.prs) {
      if (pr.head === branch && pr.state === "open") {
        return this.toChange(id, pr);
      }
    }
    return undefined;
  }

  async fetchChanges(since: ForgeCursor | undefined): Promise<ForgeSweep> {
    // A push reaches GitHub without touching the API, but bumps the PR all
    // the same; the sweep is where this forge notices one.
    for (const pr of this.prs.values()) {
      const tip = pr.tip ?? (await this.tip(pr.head));
      if (pr.seenTip !== tip) {
        pr.seenTip = tip;
        this.touch(pr);
      }
    }
    const swept =
      since === undefined
        ? [...this.prs].filter(([, pr]) => pr.state === "open")
        : [...this.prs].filter(([, pr]) => pr.updated > Number(since));
    const changes = await Promise.all(
      swept.map(async ([id, pr]): Promise<SweptChange> => {
        const comments = await this.listComments(id);
        const capped = this.commentCap !== undefined && comments.length > this.commentCap;
        return {
          change: await this.toChange(id, pr),
          comments: capped ? comments.slice(0, this.commentCap) : comments,
          commentsTruncated: capped,
        };
      }),
    );
    return { coverage: since === undefined ? "open" : "since", changes, cursor: forgeCursor(String(this.clock - 1)) };
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    return this.toChange(id, this.pr(id));
  }

  async createChange(head: ChangeName, parent: ChangeName, title: string, draft: boolean): Promise<ForgeChange> {
    return this.getChange(this.openPr(this.tokenLogin, head, parent, title, draft));
  }

  async setParent(id: ForgeChangeId, parent: ChangeName): Promise<void> {
    const pr = this.pr(id);
    pr.base = parent;
    this.touch(pr);
  }

  async setDraft(id: ForgeChangeId, draft: boolean): Promise<void> {
    const pr = this.pr(id);
    pr.draft = draft;
    this.touch(pr);
  }

  async setState(id: ForgeChangeId, state: "open" | "closed"): Promise<void> {
    const pr = this.pr(id);
    if (pr.state === "merged") {
      throw new Error(`PR ${id} is merged`);
    }
    pr.state = state;
    this.touch(pr);
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    expectedTip: Revision,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    const pr = this.pr(id);
    if (pr.state !== "open") {
      throw new Error(`PR ${id} is ${pr.state}`);
    }
    const onto = await this.tip(pr.base);
    const tip = await this.tip(pr.head);
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
    this.touch(pr);
    return pr.merge;
  }

  async listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]> {
    return this.pr(id).comments.map((comment) => ({
      id: comment.id,
      author: loginIdentity(comment.login),
      body: comment.body,
      updatedAt: timestampMs(comment.updatedAt),
    }));
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    this.comment(id, this.tokenLogin, body);
  }

  async setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void> {
    const pr = this.pr(id);
    let moved = false;
    for (const user of add) {
      const login = identityLogin(user);
      moved = !pr.requested.has(login) || moved;
      pr.requested.add(login);
    }
    // Only a pending request can be withdrawn, as on GitHub: a submitted
    // review cannot be unmade.
    for (const user of remove) {
      moved = pr.requested.delete(identityLogin(user)) || moved;
    }
    if (moved) {
      this.touch(pr);
    }
  }

  /** A PR opened on the forge by `login`; returns its number. */
  openPr(login: string, head: ChangeName, base: ChangeName, title: string, draft = false): ForgeChangeId {
    const id = forgeChangeId(this.prs.size + 1);
    this.prs.set(id, {
      head,
      base,
      title,
      login,
      state: "open",
      draft,
      comments: [],
      requested: new Set(),
      reviewed: new Set(),
      updated: this.clock++,
    });
    return id;
  }

  /** The draft toggle, clicked on the forge by a teammate. */
  toggleDraft(id: ForgeChangeId, draft: boolean): void {
    const pr = this.pr(id);
    pr.draft = draft;
    this.touch(pr);
  }

  /** Review requested from `login` on the forge, as by a teammate. */
  requestReviewer(id: ForgeChangeId, login: string): void {
    const pr = this.pr(id);
    pr.requested.add(login);
    this.touch(pr);
  }

  /** A review request withdrawn on the forge, as by a teammate. */
  withdrawReviewer(id: ForgeChangeId, login: string): void {
    const pr = this.pr(id);
    if (pr.requested.delete(login)) {
      this.touch(pr);
    }
  }

  /** A review submitted by `login`: the pending request completes, and GitHub counts them a reviewer forever. */
  review(id: ForgeChangeId, login: string): void {
    const pr = this.pr(id);
    pr.requested.delete(login);
    pr.reviewed.add(login);
    this.touch(pr);
  }

  /** The close button: the PR is declined without merging. */
  close(id: ForgeChangeId): void {
    const pr = this.pr(id);
    pr.state = "closed";
    this.touch(pr);
  }

  /** A comment posted on the forge by `login`; returns its id. */
  comment(id: ForgeChangeId, login: string, body: string): string {
    const commentId = String(this.nextComment++);
    const pr = this.pr(id);
    pr.comments.push({ id: commentId, login, body, updatedAt: this.clock++ });
    this.touch(pr);
    return commentId;
  }

  /** Edit comment `commentId` in place, as the forge does. */
  edit(id: ForgeChangeId, commentId: string, body: string): void {
    const pr = this.pr(id);
    const comment = pr.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) {
      throw new Error(`no comment ${commentId} on PR ${id}`);
    }
    comment.body = body;
    comment.updatedAt = this.clock++;
    this.touch(pr);
  }

  /** The merge button, pressed after `mergeCommit` reached the base branch out of band. */
  merge(id: ForgeChangeId, mergeCommit: Revision, parents = 2): void {
    const pr = this.pr(id);
    pr.state = "merged";
    pr.merge = { commit: mergeCommit, parents };
    this.touch(pr);
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
      tip: pr.tip ?? (await this.tip(pr.head)),
      parent: pr.base,
      title: pr.title,
      author: loginIdentity(pr.login),
      state: pr.state,
      draft: pr.draft,
      reviewers: [...new Set([...pr.requested, ...pr.reviewed])].sort().map(loginIdentity),
      ...(pr.merge === undefined ? {} : { merge: pr.merge }),
    };
  }
}

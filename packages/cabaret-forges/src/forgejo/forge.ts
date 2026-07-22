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
import { type ForgejoClient, type ForgejoRepo, isStatus } from "./client.js";

/** The identity for a Codeberg account: its login under the `codeberg:` scheme. */
function accountUser(login: string): UserName {
  return forgeAccount("codeberg", login);
}

// Inverts `accountUser`.
const ACCOUNT = /^codeberg:(.+)$/;

// Codeberg's hidden-email placeholder names its account just as well, so a
// pasted noreply address is taken as the account it belongs to.
const NOREPLY = /^([^@]+)@noreply\.codeberg\.org$/;

/**
 * The login a Cabaret identity names — `accountUser`'s inverse, also taking
 * Codeberg's noreply placeholder form. Fails for an identity that names no
 * account: emails are not searched, since search matches names as loosely as
 * emails and a review request must never land on whichever stranger matched
 * first.
 */
function accountLogin(user: UserName): string {
  const login = ACCOUNT.exec(user)?.[1] ?? NOREPLY.exec(user)?.[1];
  if (login === undefined) {
    throw new UserError(`${JSON.stringify(user)} names no codeberg.org account; use codeberg:<login>`);
  }
  return login;
}

const UserSchema = z.object({ login: z.string() });

const PrSchema = z.object({
  number: z.number().transform(forgeChangeId),
  updated_at: z.string(),
  title: z.string(),
  user: UserSchema.nullable(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  merge_commit_sha: z.string().transform(parseCommitHash).nullable(),
  head: z.object({ ref: z.string().transform(parseBranchName), sha: z.string().transform(parseCommitHash) }),
  base: z.object({ ref: z.string().transform(parseBranchName) }),
  requested_reviewers: z.array(UserSchema.nullable()).nullable(),
});

type Pr = z.infer<typeof PrSchema>;

// A review's reviewer is null when a team was asked, or the account is gone.
const ReviewSchema = z.object({
  user: UserSchema.nullable(),
  state: z.enum(["APPROVED", "PENDING", "COMMENT", "REQUEST_CHANGES", "REQUEST_REVIEW", ""]),
});

/** The states of a review someone has actually submitted — not a pending draft, and not the request record itself. */
const SUBMITTED = new Set(["APPROVED", "COMMENT", "REQUEST_CHANGES"]);

const CommentSchema = z.object({
  id: z.number(),
  user: UserSchema.nullable(),
  body: z.string(),
  updated_at: z.string(),
});

const CommitSchema = z.object({
  parents: z.array(z.object({ sha: z.string().transform(parseCommitHash) })),
});

// The merged-commit field of a PR: what a landed PR is re-fetched for, since
// the merge call itself returns nothing.
const MergedPrSchema = z.object({
  merge_commit_sha: z.string().transform(parseCommitHash).nullable(),
});

const TitleSchema = z.object({ title: z.string(), draft: z.boolean() });

// A row of the issues listing, which is the one Forgejo endpoint that can
// filter pulls by update time; the pulls themselves are fetched by number.
const IssueSchema = z.object({
  number: z.number().transform(forgeChangeId),
  updated_at: z.string(),
});

/**
 * How far back a minted cursor trails the newest activity a sweep read.
 * Stamps are written synchronously, but a read may come from a lagging
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

// Forgejo's default work-in-progress title prefixes, matched case-insensitively
// as the server matches them; codeberg.org runs the defaults.
const WIP = /^(?:wip:|\[wip\])\s*/i;

/** A `Forge` for a codeberg.org repository, speaking the API directly. */
export class ForgejoForge implements Forge {
  readonly locator: ForgeLocator;
  /** The API path prefix naming the repository. */
  private readonly api: string;

  constructor(
    private readonly client: ForgejoClient,
    repo: ForgejoRepo,
  ) {
    this.locator = parseForgeLocator(`codeberg.org/${repo.owner}/${repo.repo}`);
    this.api = `/repos/${repo.owner}/${repo.repo}`;
  }

  async currentSelf(): Promise<Self> {
    const { login, email } = z.object({ login: z.string(), email: z.string() }).parse(await this.client.get("/user"));
    const aliases = new Set<UserName>();
    if (email !== "") {
      aliases.add(userName(email));
    }
    return { user: accountUser(login), aliases };
  }

  private async toChange(pr: Pr): Promise<ForgeChange> {
    // A reviewer who reviewed with only comments drops out of
    // `requested_reviewers` (an approval or rejection keeps them there), so
    // the reviewer set is that union'd with the submitted reviews' authors.
    const reviews = z
      .array(ReviewSchema)
      .parse(await this.client.getPaginated(`${this.api}/pulls/${pr.number}/reviews`));
    const logins = new Set(
      [
        ...(pr.requested_reviewers ?? []).map((user) => user?.login),
        ...reviews.filter(({ state }) => SUBMITTED.has(state)).map(({ user }) => user?.login),
      ].filter((login) => login !== undefined),
    );
    return {
      id: pr.number,
      head: pr.head.ref,
      tip: pr.head.sha,
      parent: pr.base.ref,
      title: pr.title,
      author: accountUser(pr.user?.login ?? "ghost"),
      state: pr.merged ? "merged" : pr.state,
      // Sorted by identity: the forge promises no order of its own.
      reviewers: [...logins].map(accountUser).sort(),
      draft: pr.draft,
      ...(pr.merged ? { merge: await this.mergeOf(pr) } : {}),
    };
  }

  private async mergeOf(pr: Pr): Promise<ForgeMerge> {
    // A merged PR without a recorded merge commit was marked manually merged
    // elsewhere; the head itself is the best name for what landed.
    return this.landingShape(pr.merge_commit_sha ?? pr.head.sha, pr.head.sha);
  }

  /**
   * How `commit` landed a PR whose reviewed head was `tip`. Forgejo's landing
   * shapes: a true merge's commit carries the reviewed head as its second
   * parent; a rebase-then-merge carries rebased, unreviewed commits there
   * instead; and squash, rebase, and fast-forward put single-parent commits on
   * the target. Only the true merge preserves review ancestry, so only it
   * reports 2.
   */
  private async landingShape(commit: Revision, tip: Revision): Promise<ForgeMerge> {
    // Only the parents matter; the diff stats and file list served by default
    // can be huge.
    const { parents } = CommitSchema.parse(
      await this.client.get(`${this.api}/git/commits/${commit}`, { stat: false, verification: false, files: false }),
    );
    return { commit, parents: parents.length === 2 && parents[1]?.sha === tip ? 2 : 1 };
  }

  private toComment(comment: z.infer<typeof CommentSchema>): ForgeComment {
    return {
      id: String(comment.id),
      author: accountUser(comment.user?.login ?? "ghost"),
      body: comment.body,
      updatedAt: timestampMs(Date.parse(comment.updated_at)),
    };
  }

  private async listOpenPrs(): Promise<readonly Pr[]> {
    return z.array(PrSchema).parse(await this.client.getPaginated(`${this.api}/pulls`, { state: "open" }));
  }

  async findChange(branch: ChangeName): Promise<ForgeChange | undefined> {
    // The API cannot filter by head branch, so the open PRs are listed and
    // matched here; several on one branch collapse to the lowest number, the
    // one `fetchForge` would import.
    const found = (await this.listOpenPrs())
      .filter((pr) => pr.head.ref === branch)
      .sort((a, b) => a.number - b.number)[0];
    return found === undefined ? undefined : this.toChange(found);
  }

  private async toSweptChange(pr: Pr): Promise<SweptChange> {
    return {
      change: await this.toChange(pr),
      comments: await this.listComments(pr.number),
      commentsTruncated: false,
    };
  }

  async fetchChanges(since: ForgeCursor | undefined): Promise<ForgeSweep> {
    // Forgejo has no bulk query, so the sweep costs a few calls per PR it
    // carries; in return every discussion comes back whole, and nothing
    // truncates. A cursor narrows the carried set to what the issues
    // listing — the one endpoint filtering pulls by update time — reports
    // touched, every state included.
    const resume = cursorMs(since);
    const prs =
      resume === undefined
        ? await this.listOpenPrs()
        : await Promise.all(
            z
              .array(IssueSchema)
              .parse(
                await this.client.getPaginated(`${this.api}/issues`, {
                  type: "pulls",
                  state: "all",
                  since: new Date(resume).toISOString(),
                }),
              )
              .map(async ({ number }) => PrSchema.parse(await this.client.get(`${this.api}/pulls/${number}`))),
          );
    const changes = await Promise.all(prs.map(this.toSweptChange, this));
    const newest = Math.max(0, ...prs.map(({ updated_at }) => Date.parse(updated_at)));
    // Never regresses: an empty sweep resumes where this one began.
    const minted = Math.max(resume ?? 0, newest - CURSOR_OVERLAP_MS);
    return {
      coverage: resume === undefined ? "open" : "since",
      changes,
      cursor: minted > 0 ? forgeCursor(String(minted)) : undefined,
    };
  }

  async getChange(id: ForgeChangeId): Promise<ForgeChange> {
    let data: unknown;
    try {
      data = await this.client.get(`${this.api}/pulls/${id}`);
    } catch (error) {
      if (isStatus(error, 404)) {
        throw new UserError(`no pull request #${id} on ${this.locator}`);
      }
      throw error;
    }
    return this.toChange(PrSchema.parse(data));
  }

  async createChange(head: ChangeName, parent: ChangeName, title: string): Promise<ForgeChange> {
    // The response names the new PR; fetching by its number — never by head,
    // which could race another PR on the same branch — reuses the one query
    // that maps a PR.
    const data = await this.client.post(`${this.api}/pulls`, {
      head,
      base: parent,
      title,
    });
    return this.getChange(forgeChangeId(z.object({ number: z.number() }).parse(data).number));
  }

  async setParent(id: ForgeChangeId, parent: ChangeName): Promise<void> {
    await this.client.patch(`${this.api}/pulls/${id}`, { base: parent });
  }

  // TODO: Gitea grew a branch-rename endpoint; adopt it once verified
  // against a live Forgejo instance.
  async renameBranch(): Promise<void> {
    throw new UserError(`${this.locator} cannot rename branches`);
  }

  async setState(id: ForgeChangeId, state: "open" | "closed"): Promise<void> {
    await this.client.patch(`${this.api}/pulls/${id}`, { state });
  }

  async setDraft(id: ForgeChangeId, draft: boolean): Promise<void> {
    // Forgejo keeps draft state in the title's work-in-progress prefix; the
    // API's `draft` field only reads it, so toggling edits the title.
    const pr = TitleSchema.parse(await this.client.get(`${this.api}/pulls/${id}`));
    if (pr.draft === draft) {
      return;
    }
    await this.client.patch(`${this.api}/pulls/${id}`, {
      title: draft ? `WIP: ${pr.title}` : pr.title.replace(WIP, ""),
    });
  }

  async landChange(
    id: ForgeChangeId,
    method: LandMethod,
    tip: Revision,
    title: string,
    message: string,
  ): Promise<ForgeMerge> {
    try {
      // Forgejo's merge styles share Cabaret's land method names.
      await this.client.post(`${this.api}/pulls/${id}/merge`, {
        Do: method,
        MergeTitleField: title,
        MergeMessageField: message,
        // Forgejo merges only while the head still matches, closing the race
        // between the caller's validation and this call.
        head_commit_id: tip,
      });
    } catch (error) {
      // 405 is Forgejo refusing the merge as such — the style is disabled in
      // repository settings, or a protection rule is unmet — and 409 is a PR
      // that does not merge cleanly or a head that moved since `tip` was
      // validated; all are the user's to resolve, and Forgejo's message says
      // which it was.
      if (isStatus(error, 405) || isStatus(error, 409)) {
        throw new UserError(`${this.locator}#${id} did not merge: ${(error as Error).message}`);
      }
      throw error;
    }
    // The merge response is empty, so the landed commit is read back off the
    // PR — and its shape off the commit itself, rather than trusted from
    // `method`.
    const merged = MergedPrSchema.parse(await this.client.get(`${this.api}/pulls/${id}`));
    return this.landingShape(merged.merge_commit_sha ?? tip, tip);
  }

  async listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]> {
    // The endpoint serves the whole discussion in one unpaginated response —
    // in creation order, oldest first, as the interface promises — and only
    // discussion comments, never Forgejo's own narration of the PR.
    const data = await this.client.get(`${this.api}/issues/${id}/comments`);
    return z.array(CommentSchema).parse(data).map(this.toComment, this);
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    await this.client.post(`${this.api}/issues/${id}/comments`, { body });
  }

  async setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void> {
    const adding = add.map(accountLogin);
    const removing = remove.map(accountLogin);
    try {
      if (adding.length > 0) {
        await this.client.post(`${this.api}/pulls/${id}/requested_reviewers`, { reviewers: adding });
      }
      // Withdrawing a reviewer who has already reviewed is a server-side
      // no-op — their request row is gone, and their review keeps them on the
      // change — so they are left as they are and mirror back in on the next
      // pull.
      if (removing.length > 0) {
        await this.client.delete(`${this.api}/pulls/${id}/requested_reviewers`, { reviewers: removing });
      }
    } catch (error) {
      // 422 is Forgejo refusing a reviewer as such — the PR's own author, or
      // an account that cannot review — and 404 one that does not exist; the
      // message names the account.
      if (isStatus(error, 422) || isStatus(error, 404)) {
        throw new UserError(`${this.locator}#${id} reviewers not updated: ${(error as Error).message}`);
      }
      throw error;
    }
  }
}

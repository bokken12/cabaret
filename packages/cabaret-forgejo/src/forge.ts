import {
  type ChangeName,
  type Forge,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  forgeChangeId,
  type LandMethod,
  type OpenChange,
  parseBranchName,
  parseCommitHash,
  parseForgeLocator,
  type Revision,
  timestampMs,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { z } from "zod";
import { type ForgejoClient, type ForgejoRepo, isStatus } from "./client.js";

/** The identity for a login whose account shows no email: Codeberg's own noreply convention, the same form the API serves for a hidden email. */
function noreplyUser(login: string): UserName {
  return userName(`${login.toLowerCase()}@noreply.codeberg.org`);
}

// Inverts `noreplyUser`.
const NOREPLY = /^([^@]+)@noreply\.codeberg\.org$/;

const UserSchema = z.object({ login: z.string() });

const PrSchema = z.object({
  number: z.number().transform(forgeChangeId),
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

const UserSearchSchema = z.object({ data: z.array(z.object({ login: z.string(), email: z.string() })) });

// Forgejo's default work-in-progress title prefixes, matched case-insensitively
// as the server matches them; codeberg.org runs the defaults.
const WIP = /^(?:wip:|\[wip\])\s*/i;

/** A `Forge` for a codeberg.org repository, speaking the API directly. */
export class ForgejoForge implements Forge {
  private readonly identities = new Map<string, Promise<UserName>>();
  private readonly logins = new Map<UserName, Promise<string>>();
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

  /**
   * The Cabaret identity for `login`: the account's email as the profile
   * lookup serves it — the real one when public, the noreply placeholder when
   * hidden — so the mapping is total without special cases. Looked up per
   * login rather than read off embedded user objects, which carry the
   * placeholder for every user on some surfaces (comments, requested
   * reviewers) and the real email on others. One API call per login; only a
   * success is cached, so a transient failure cannot pin a wrong identity for
   * the forge's lifetime.
   */
  private identity(login: string): Promise<UserName> {
    let pending = this.identities.get(login);
    if (pending === undefined) {
      pending = this.client
        .get(`/users/${encodeURIComponent(login)}`)
        .then((data) => {
          const { email } = z.object({ email: z.string() }).parse(data);
          return email === "" ? noreplyUser(login) : userName(email);
        })
        .catch((error: unknown) => {
          // Deleted accounts 404; their PRs and comments still need an identity.
          if (isStatus(error, 404)) {
            return noreplyUser(login);
          }
          this.identities.delete(login);
          throw error;
        });
      this.identities.set(login, pending);
    }
    return pending;
  }

  /**
   * The login for a Cabaret identity — `identity`'s inverse. A noreply
   * identity names its login directly; anything else costs a user search,
   * cached for this forge's lifetime. Only a success is cached, so a transient
   * failure cannot pin a wrong login for the forge's lifetime. Search matches
   * names as loosely as emails, so only an exact email match may stand in for
   * the identity — a review request must never land on whichever stranger
   * matched first.
   */
  private login(user: UserName): Promise<string> {
    const noreply = NOREPLY.exec(user)?.[1];
    if (noreply !== undefined) {
      return Promise.resolve(noreply);
    }
    let pending = this.logins.get(user);
    if (pending === undefined) {
      pending = this.client
        .get("/users/search", { q: user })
        .then((data) => {
          const match = UserSearchSchema.parse(data).data.find(({ email }) => email === user);
          if (match === undefined) {
            throw new UserError(`no codeberg.org account found for ${JSON.stringify(user)}`);
          }
          return match.login;
        })
        .catch((error: unknown) => {
          this.logins.delete(user);
          throw error;
        });
      this.logins.set(user, pending);
    }
    return pending;
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
    const reviewers = await Promise.all([...logins].map((login) => this.identity(login)));
    return {
      id: pr.number,
      head: pr.head.ref,
      tip: pr.head.sha,
      parent: pr.base.ref,
      title: pr.title,
      author: pr.user === null ? noreplyUser("ghost") : await this.identity(pr.user.login),
      state: pr.merged ? "merged" : pr.state,
      // Sorted by identity: the forge promises no order of its own.
      reviewers: reviewers.sort(),
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

  private async toComment(comment: z.infer<typeof CommentSchema>): Promise<ForgeComment> {
    return {
      id: String(comment.id),
      author: comment.user === null ? noreplyUser("ghost") : await this.identity(comment.user.login),
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
    // one `pullForge` would import.
    const found = (await this.listOpenPrs())
      .filter((pr) => pr.head.ref === branch)
      .sort((a, b) => a.number - b.number)[0];
    return found === undefined ? undefined : this.toChange(found);
  }

  async fetchOpenChanges(): Promise<readonly OpenChange[]> {
    // Forgejo has no bulk query, so the sweep costs a few calls per open PR;
    // in return every discussion comes back whole, and nothing truncates.
    const prs = await this.listOpenPrs();
    return Promise.all(
      prs.map(async (pr) => ({
        change: await this.toChange(pr),
        comments: await this.listComments(pr.number),
        commentsTruncated: false,
      })),
    );
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

  async createChange(head: ChangeName, parent: ChangeName, title: string, draft: boolean): Promise<ForgeChange> {
    // Creation cannot mark a draft, so a draft opens under the work-in-progress
    // title prefix. The response names the new PR; fetching by its number —
    // never by head, which could race another PR on the same branch — reuses
    // the one query that maps a PR.
    const data = await this.client.post(`${this.api}/pulls`, {
      head,
      base: parent,
      title: draft ? `WIP: ${title}` : title,
    });
    return this.getChange(forgeChangeId(z.object({ number: z.number() }).parse(data).number));
  }

  async setParent(id: ForgeChangeId, parent: ChangeName): Promise<void> {
    await this.client.patch(`${this.api}/pulls/${id}`, { base: parent });
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
    return Promise.all(z.array(CommentSchema).parse(data).map(this.toComment, this));
  }

  async addComment(id: ForgeChangeId, body: string): Promise<void> {
    await this.client.post(`${this.api}/issues/${id}/comments`, { body });
  }

  async setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void> {
    const [adding, removing] = await Promise.all([
      Promise.all(add.map((user) => this.login(user))),
      Promise.all(remove.map((user) => this.login(user))),
    ]);
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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/**
 * Run the GitHub CLI in `cwd` and return its stdout. `gh` supplies the
 * repository (from the `origin` remote) and authentication (`gh auth login`),
 * so Cabaret never handles a token. On nonzero exit the rejection already
 * names the command and carries stderr in its message.
 */
async function gh(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 1024 ** 3 });
  return stdout;
}

const PR_FIELDS = "number,headRefName,baseRefName,title,author,state,mergeCommit,changedFiles";

/** The identity for a login whose profile shows no email: GitHub's own noreply convention. */
function noreplyUser(login: string): UserName {
  return userName(`${login}@users.noreply.github.com`);
}

const PrSchema = z.object({
  number: z.number().transform(forgeRequestId),
  headRefName: z.string().transform(parseRefName),
  baseRefName: z.string().transform(parseRefName),
  title: z.string(),
  author: z.object({ login: z.string() }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: z.object({ oid: z.string().transform(parseCommitHash) }).nullable(),
  changedFiles: z.number(),
});

const IssueCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  updated_at: z.string(),
});

/** A `Forge` that shells out to the `gh` CLI against the `origin` remote's repository. */
export class GitHubForge implements Forge {
  private readonly identities = new Map<string, Promise<UserName>>();

  private constructor(
    private readonly root: string,
    readonly locator: ForgeLocator,
  ) {}

  /**
   * The Cabaret identity for `login`: the account's public profile email when
   * it shows one, else GitHub's noreply convention. One `gh api` call per
   * login, cached for this forge's lifetime.
   */
  private identity(login: string): Promise<UserName> {
    let pending = this.identities.get(login);
    if (pending === undefined) {
      pending = gh(this.root, ["api", `users/${login}`, "--jq", '.email // ""'])
        .then((out) => {
          const email = out.trim();
          return email === "" ? noreplyUser(login) : userName(email);
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
      author: await this.identity(pr.author.login),
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

  /** Open the forge for the repository containing `dir`. */
  static async open(dir: string): Promise<GitHubForge> {
    const out = await gh(dir, ["repo", "view", "--json", "url"]);
    const { url } = z.object({ url: z.string() }).parse(JSON.parse(out));
    return new GitHubForge(dir, parseForgeLocator(url.replace(/^https?:\/\//, "")));
  }

  async findRequest(branch: RefName): Promise<ForgeRequest | undefined> {
    const out = await gh(this.root, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      PR_FIELDS,
    ]);
    const found = z.array(PrSchema).parse(JSON.parse(out))[0];
    return found === undefined ? undefined : this.toRequest(found);
  }

  async listOpenRequests(): Promise<readonly ForgeRequest[]> {
    // `gh pr list` returns 30 requests unless told otherwise; 1000 covers any
    // repository whose open requests a person still reads through.
    const out = await gh(this.root, ["pr", "list", "--state", "open", "--limit", "1000", "--json", PR_FIELDS]);
    return Promise.all(z.array(PrSchema).parse(JSON.parse(out)).map(this.toRequest, this));
  }

  async getRequest(id: ForgeRequestId): Promise<ForgeRequest> {
    const out = await gh(this.root, ["pr", "view", String(id), "--json", PR_FIELDS]);
    return this.toRequest(PrSchema.parse(JSON.parse(out)));
  }

  async createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest> {
    await gh(this.root, ["pr", "create", "--head", head, "--base", base, "--title", title, "--body", ""]);
    const created = await this.findRequest(head);
    if (created === undefined) {
      throw new Error(`created a pull request for ${JSON.stringify(head)} but cannot find it`);
    }
    return created;
  }

  async setBase(id: ForgeRequestId, base: RefName): Promise<void> {
    await gh(this.root, ["pr", "edit", String(id), "--base", base]);
  }

  async listFiles(id: ForgeRequestId): Promise<readonly FilePath[]> {
    // --paginate walks every page; --jq flattens each page's array to one
    // path per line. A renamed file lists under its new path.
    const out = await gh(this.root, [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/pulls/${id}/files`,
      "--jq",
      ".[].filename",
    ]);
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map(parseFilePath);
  }

  async listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]> {
    // --paginate fetches every page; --jq flattens each page's array to one
    // comment per line.
    const out = await gh(this.root, ["api", "--paginate", `repos/{owner}/{repo}/issues/${id}/comments`, "--jq", ".[]"]);
    return Promise.all(
      out
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => this.toComment(IssueCommentSchema.parse(JSON.parse(line)))),
    );
  }

  async addComment(id: ForgeRequestId, body: string): Promise<void> {
    await gh(this.root, ["api", `repos/{owner}/{repo}/issues/${id}/comments`, "-f", `body=${body}`]);
  }
}

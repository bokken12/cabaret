import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type Forge,
  type ForgeComment,
  type ForgeLocator,
  type ForgeRequest,
  type ForgeRequestId,
  forgeRequestId,
  parseCommitHash,
  parseForgeLocator,
  parseRefName,
  type RefName,
  timestampMs,
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

const PR_FIELDS = "number,headRefName,baseRefName,title,state,mergeCommit";

const PrSchema = z.object({
  number: z.number().transform(forgeRequestId),
  headRefName: z.string().transform(parseRefName),
  baseRefName: z.string().transform(parseRefName),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: z.object({ oid: z.string().transform(parseCommitHash) }).nullable(),
});

function toRequest(pr: z.infer<typeof PrSchema>): ForgeRequest {
  return {
    id: pr.number,
    head: pr.headRefName,
    base: pr.baseRefName,
    title: pr.title,
    state: pr.state === "OPEN" ? "open" : pr.state === "CLOSED" ? "closed" : "merged",
    ...(pr.mergeCommit === null ? {} : { merge: pr.mergeCommit.oid }),
  };
}

const IssueCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  updated_at: z.string(),
});

function toComment(comment: z.infer<typeof IssueCommentSchema>): ForgeComment {
  return {
    id: String(comment.id),
    // GitHub does not expose members' emails, so authors import under
    // GitHub's own noreply convention for their login.
    author: userName(`${comment.user.login}@users.noreply.github.com`),
    body: comment.body,
    updatedAt: timestampMs(Date.parse(comment.updated_at)),
  };
}

/** A `Forge` that shells out to the `gh` CLI against the `origin` remote's repository. */
export class GitHubForge implements Forge {
  private constructor(
    private readonly root: string,
    readonly locator: ForgeLocator,
  ) {}

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
    return found === undefined ? undefined : toRequest(found);
  }

  async getRequest(id: ForgeRequestId): Promise<ForgeRequest> {
    const out = await gh(this.root, ["pr", "view", String(id), "--json", PR_FIELDS]);
    return toRequest(PrSchema.parse(JSON.parse(out)));
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

  async listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]> {
    // --paginate fetches every page; --jq flattens each page's array to one
    // comment per line.
    const out = await gh(this.root, ["api", "--paginate", `repos/{owner}/{repo}/issues/${id}/comments`, "--jq", ".[]"]);
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => toComment(IssueCommentSchema.parse(JSON.parse(line))));
  }

  async addComment(id: ForgeRequestId, body: string): Promise<void> {
    await gh(this.root, ["api", `repos/{owner}/{repo}/issues/${id}/comments`, "-f", `body=${body}`]);
  }
}

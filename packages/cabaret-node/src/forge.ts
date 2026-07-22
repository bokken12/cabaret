import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Forge, UserError } from "cabaret-core";
import {
  ForgejoClient,
  ForgejoForge,
  GitHubForge,
  GitLabClient,
  GitLabForge,
  githubClient,
  parseForgejoRemote,
  parseGitHubRemote,
  parseGitLabRemote,
} from "cabaret-forges";

const execFileAsync = promisify(execFile);

type ForgeHost = "github.com" | "gitlab.com" | "codeberg.org";

/**
 * There is no forge here: origin names no supported forge, or there is no
 * origin at all. Sync and fetch proceed without a forge on this error, so a
 * plain-git origin still shares branches and logs; a misconfigured token on
 * a real forge stays a plain failure and surfaces.
 */
export class NoForgeError extends UserError {}

/** The host named by one of the remote URL forms the supported forges accept. */
function remoteHost(url: string): ForgeHost {
  const match = /^(?:https:\/\/([^/]+)\/|git@([^:]+):|ssh:\/\/git@([^/]+)\/)/i.exec(url);
  const host = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
  switch (host) {
    case "github.com":
    case "gitlab.com":
    case "codeberg.org":
      return host;
    default:
      throw new NoForgeError(
        `unsupported forge origin: ${JSON.stringify(url)}; expected github.com, gitlab.com, or codeberg.org`,
      );
  }
}

/** The first nonempty environment variable named by `names`. */
function envToken(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * Fallback token sources, consulted only when the ambient resolution — env
 * vars, then the forge's own CLI login — finds nothing. Cabaret stores no
 * token of its own; a host with its own account store (cabaret-vscode)
 * supplies one of these to sign the user in itself.
 */
export interface ForgeAuth {
  readonly github?: () => Promise<string>;
  // TODO: gitlab.com and codeberg.org sources, once a host can mint their
  // tokens: VS Code only ships a GitHub authentication provider, so the
  // others need a PAT prompt or a Cabaret-registered OAuth app.
}

/**
 * The token for GitHub API calls: $GH_TOKEN or $GITHUB_TOKEN when set, else
 * the `gh` CLI's stored login, else `fallback`.
 */
async function githubToken(fallback?: () => Promise<string>): Promise<string> {
  const env = envToken("GH_TOKEN", "GITHUB_TOKEN");
  if (env !== undefined) {
    return env;
  }
  const token = await execFileAsync("gh", ["auth", "token"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (token !== "") {
    return token;
  }
  if (fallback !== undefined) {
    return fallback();
  }
  throw new UserError("no GitHub token: set GH_TOKEN or run `gh auth login`");
}

function gitlabToken(): string {
  const token = envToken("GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN");
  if (token === undefined) {
    throw new UserError("no GitLab token: set GITLAB_TOKEN");
  }
  return token;
}

function codebergToken(): string {
  const token = envToken("CODEBERG_TOKEN");
  if (token === undefined) {
    throw new UserError("no Codeberg token: set CODEBERG_TOKEN");
  }
  return token;
}

/** Open the supported forge named by the `origin` remote of the git repository containing `dir`. */
export async function openForge(dir: string, auth: ForgeAuth = {}): Promise<Forge> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: dir }));
  } catch {
    // No git, no repository, or no origin remote: nowhere a forge could be.
    throw new NoForgeError("no forge: the repository has no git origin remote");
  }
  const url = stdout.trimEnd();
  switch (remoteHost(url)) {
    case "github.com": {
      const repo = parseGitHubRemote(url);
      return new GitHubForge(githubClient(await githubToken(auth.github)), repo);
    }
    case "gitlab.com": {
      const project = parseGitLabRemote(url);
      return new GitLabForge(new GitLabClient(gitlabToken()), project);
    }
    case "codeberg.org": {
      const repo = parseForgejoRemote(url);
      return new ForgejoForge(new ForgejoClient(codebergToken()), repo);
    }
  }
}

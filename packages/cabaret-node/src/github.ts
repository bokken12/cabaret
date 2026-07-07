import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UserError } from "cabaret-core";
import { GitHubForge, parseGitHubRemote } from "cabaret-github";

const execFileAsync = promisify(execFile);

/**
 * The token for GitHub API calls: $GH_TOKEN or $GITHUB_TOKEN when set, else
 * the `gh` CLI's stored login. Auth stays delegated to `gh auth login`;
 * Cabaret stores no token of its own.
 */
async function githubToken(): Promise<string> {
  // `||`, not `??`: an empty variable means unset, exactly as `gh` reads it.
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env !== undefined && env !== "") {
    return env;
  }
  const token = await execFileAsync("gh", ["auth", "token"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (token === "") {
    throw new UserError("no GitHub token: set GH_TOKEN or run `gh auth login`");
  }
  return token;
}

/** Open the `Forge` for the `origin` remote of the repository containing `dir`. */
export async function openGitHubForge(dir: string): Promise<GitHubForge> {
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: dir });
  return new GitHubForge(await githubToken(), parseGitHubRemote(stdout.trimEnd()));
}

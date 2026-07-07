import { type GitHubRepo, parseGitHubRemote } from "cabaret-github";

/** What the app needs to talk to GitHub: a repository and a token for it. */
export interface Config {
  readonly repo: GitHubRepo;
  readonly token: string;
}

/**
 * Parse a repository the way a user names one: "owner/repo", with or without
 * a "github.com/" or URL prefix — every form funnels through the remote-URL
 * parser so casing normalizes identically everywhere.
 */
export function parseRepo(raw: string): GitHubRepo {
  const trimmed = raw.trim().replace(/^github\.com\//i, "");
  const url = /^(?:https:|ssh:|git@)/i.test(trimmed) ? trimmed : `https://github.com/${trimmed}`;
  return parseGitHubRemote(url);
}

const REPO_KEY = "cabaret.repo";
const TOKEN_KEY = "cabaret.token";

export function loadConfig(): Config | undefined {
  const repo = localStorage.getItem(REPO_KEY);
  const token = localStorage.getItem(TOKEN_KEY);
  if (repo === null || token === null) {
    return undefined;
  }
  try {
    return { repo: parseRepo(repo), token };
  } catch {
    return undefined;
  }
}

export function saveConfig(config: Config): void {
  localStorage.setItem(REPO_KEY, `${config.repo.owner}/${config.repo.repo}`);
  localStorage.setItem(TOKEN_KEY, config.token);
}

export function clearConfig(): void {
  localStorage.removeItem(REPO_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

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

export function loadToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function loadRepo(): GitHubRepo | undefined {
  const raw = localStorage.getItem(REPO_KEY);
  if (raw === null) {
    return undefined;
  }
  try {
    return parseRepo(raw);
  } catch {
    return undefined;
  }
}

export function saveRepo(repo: GitHubRepo): void {
  localStorage.setItem(REPO_KEY, `${repo.owner}/${repo.repo}`);
}

/** Forget the repository but stay signed in, returning to the repository picker. */
export function clearRepo(): void {
  localStorage.removeItem(REPO_KEY);
}

export function clearConfig(): void {
  localStorage.removeItem(REPO_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

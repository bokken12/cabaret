import type { SideBySide } from "cabaret-core";
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
const CONTEXT_KEY = "cabaret.context";
const SIDE_BY_SIDE_KEY = "cabaret.sideBySide";

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

/**
 * Lines of context to show around diff hunks: a nonnegative integer, or -1
 * for whole files; unset (the renderer's default) when absent or malformed.
 * The knob is the localStorage entry itself until a settings page exists.
 */
export function loadContext(): number | undefined {
  const raw = localStorage.getItem(CONTEXT_KEY);
  const context = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(context) && context >= -1 ? context : undefined;
}

/**
 * Lay diff pages out side by side, wrapping or truncating long rows; unified
 * when absent or malformed. As with context, the knob is the localStorage
 * entry itself.
 */
export function loadSideBySide(): SideBySide | undefined {
  const raw = localStorage.getItem(SIDE_BY_SIDE_KEY);
  return raw === "wrap" || raw === "truncate" ? raw : undefined;
}

/** Forget the repository but stay signed in, returning to the repository picker. */
export function clearRepo(): void {
  localStorage.removeItem(REPO_KEY);
}

export function clearConfig(): void {
  localStorage.removeItem(REPO_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

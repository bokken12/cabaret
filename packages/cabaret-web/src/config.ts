import { type GitHubRepo, parseGitHubRemote } from "cabaret-github";

const TOKEN_KEY = "cabaret-web.token";
const REPO_KEY = "cabaret-web.repo";
const ALIAS_KEY = "cabaret-web.aliases";
const STATE_KEY = "cabaret-web.oauth-state";
const NOTICE_KEY = "cabaret-web.notice";

export interface Config {
  readonly token: string;
  readonly repo: GitHubRepo;
  /** Identities the logs may speak of the user by, beyond the signed-in account. */
  readonly aliases: readonly string[];
}

/**
 * Parse the repository a pasted string names: a bare `owner/repo`, or any
 * clone URL a remote would carry. Lowercased either way, as remote parsing
 * lowercases, so every spelling agrees.
 */
export function parseRepo(raw: string): GitHubRepo {
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw.trim());
  const owner = bare?.[1];
  const repo = bare?.[2];
  // Dot-only names would traverse the API's URL path; GitHub allows neither.
  if (owner !== undefined && repo !== undefined && !/^\.+$/.test(owner) && !/^\.+$/.test(repo)) {
    return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  }
  return parseGitHubRemote(raw.trim());
}

export function formatRepo({ owner, repo }: GitHubRepo): string {
  return `${owner}/${repo}`;
}

/** Split a comma-separated alias spelling into the identities it names. */
export function parseAliases(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias !== "");
}

export function loadConfig(): Config | undefined {
  const token = localStorage.getItem(TOKEN_KEY);
  const raw = localStorage.getItem(REPO_KEY);
  if (token === null || raw === null) {
    return undefined;
  }
  return { token, repo: parseRepo(raw), aliases: parseAliases(savedAliases()) };
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function saveRepo(repo: GitHubRepo): void {
  localStorage.setItem(REPO_KEY, formatRepo(repo));
}

export function savedRepo(): string | undefined {
  return localStorage.getItem(REPO_KEY) ?? undefined;
}

export function saveAliases(raw: string): void {
  localStorage.setItem(ALIAS_KEY, raw);
}

export function savedAliases(): string {
  return localStorage.getItem(ALIAS_KEY) ?? "";
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Mint and hold the nonce a sign-in redirect carries; the return must echo it. */
export function mintOauthState(): string {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  return state;
}

export function takeOauthState(): string | undefined {
  const state = sessionStorage.getItem(STATE_KEY) ?? undefined;
  sessionStorage.removeItem(STATE_KEY);
  return state;
}

/** A one-shot message across a reload, e.g. why the app signed the user out. */
export function postNotice(text: string): void {
  sessionStorage.setItem(NOTICE_KEY, text);
}

export function takeNotice(): string | undefined {
  const notice = sessionStorage.getItem(NOTICE_KEY) ?? undefined;
  sessionStorage.removeItem(NOTICE_KEY);
  return notice;
}

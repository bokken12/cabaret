import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { UserError } from "cabaret-core";

/** A repository on github.com. */
export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

// The `origin` URL forms git itself uses for github.com: HTTPS, scp-like SSH,
// and full SSH, each with or without `.git`.
const REMOTE_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Parse the repository a github.com remote URL names. GitHub treats owner and
 * repository names case-insensitively, but `ForgeLocator`s (and so the
 * `source.forge` fields comment dedup compares) are matched byte-for-byte —
 * lowercasing makes every clone of one repository agree on the locator no
 * matter how its remote URL is spelled.
 */
export function parseGitHubRemote(url: string): GitHubRepo {
  const match = REMOTE_URL.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new UserError(`not a github.com repository URL: ${JSON.stringify(url)}`);
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

const GitHub = Octokit.plugin(paginateRest, retry, throttling);

/** An authenticated GitHub API client. */
export type GitHubClient = InstanceType<typeof GitHub>;

/**
 * Build a client for `token`. Octokit runs on `fetch`, so the same client
 * serves Node hosts and the browser — which `cabaret-web` requires. The
 * throttling plugin implements GitHub's recommended rate-limit behavior; a
 * limit is waited out once, but a second hit on the same call means something
 * is genuinely wrong, so it fails rather than keep hammering GitHub.
 *
 * `throttled: false` is for tests against canned responses, which the plugin
 * would otherwise pace at real-time write speed (one per second) — and its
 * limiter state is process-global, so fake timers cannot stand in.
 */
// This package compiles against bare es2025 to stay platform-agnostic, so the
// runtime-provided fetch is declared rather than imported from a lib.
declare const fetch: (url: unknown, init?: object) => Promise<unknown>;

export function githubClient(token: string, { throttled = true }: { readonly throttled?: boolean } = {}): GitHubClient {
  return new GitHub({
    auth: token,
    request: {
      // The API answers GETs with `Cache-Control: private, max-age=60`, and a
      // browser honors that: for a minute after a write, rereads of a ref
      // would come from the HTTP cache and serve the pre-write state — a
      // review mark that appears to not stick. Node's fetch never caches, so
      // this only disciplines browsers.
      fetch: (url: unknown, init: object) => fetch(url, { ...init, cache: "no-store" }),
    },
    throttle: {
      enabled: throttled,
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount === 0,
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount === 0,
    },
  });
}

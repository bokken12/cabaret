import { UserError } from "cabaret-core";

/** A repository on codeberg.org. */
export interface ForgejoRepo {
  readonly owner: string;
  readonly repo: string;
}

// The `origin` URL forms git itself uses for codeberg.org: HTTPS, scp-like SSH,
// and full SSH, each with or without `.git`.
const REMOTE_URL =
  /^(?:https:\/\/codeberg\.org\/|git@codeberg\.org:|ssh:\/\/git@codeberg\.org\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Parse the repository a codeberg.org remote URL names. Forgejo treats owner
 * and repository names case-insensitively, but `ForgeLocator`s (and so the
 * `source.forge` fields comment dedup compares) are matched byte-for-byte —
 * lowercasing makes every clone of one repository agree on the locator no
 * matter how its remote URL is spelled.
 */
export function parseForgejoRemote(url: string): ForgejoRepo {
  const match = REMOTE_URL.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new UserError(`not a codeberg.org repository URL: ${JSON.stringify(url)}`);
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/** A failed Forgejo API call, carrying the HTTP status that failed it. */
export class ForgejoRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a Forgejo API rejection with HTTP `status`; anything else is a real failure. */
export function isStatus(error: unknown, status: number): boolean {
  return error instanceof ForgejoRequestError && error.status === status;
}

// This package compiles against bare es2025 to stay platform-agnostic, so the
// runtime-provided fetch and timer are declared rather than imported from a lib.
declare const fetch: (
  url: string,
  init: object,
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;
declare const setTimeout: (callback: () => void, ms: number) => unknown;

const API_URL = "https://codeberg.org/api/v1";

// Forgejo caps a list response at 50 items — codeberg.org runs the default
// cap — so a page shorter than this is the last.
const PAGE_LIMIT = 50;

/** GET query parameters, serialized in place. */
export type Query = Readonly<Record<string, string | number | boolean>>;

/** The error text of a failed call's body: Forgejo's `message`, whatever shape it takes. */
function errorMessage(data: unknown): string {
  const { message } = (data ?? {}) as { message?: unknown };
  return typeof message === "string" ? message : (JSON.stringify(data) ?? "unknown error");
}

/**
 * An authenticated codeberg.org API client over the runtime's `fetch`, so the
 * same client serves Node hosts and the browser. A rate limit (429) is
 * waited out once, but a second hit on the same call means something is
 * genuinely wrong, so it fails rather than keep hammering the server.
 *
 * `throttled: false` is for tests against canned responses, which would
 * otherwise wait out stubbed rate limits in real time.
 */
export class ForgejoClient {
  private readonly throttled: boolean;

  constructor(
    private readonly token: string,
    { throttled = true }: { readonly throttled?: boolean } = {},
  ) {
    this.throttled = throttled;
  }

  private async fetchJson(method: string, url: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `token ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The browser would otherwise serve rereads after a write from its
        // HTTP cache — review state that appears to not stick. Node's fetch
        // never caches, so this only disciplines browsers.
        cache: "no-store",
      });
      // Parsed before the retry check so a discarded 429 body never holds
      // its connection open.
      const data = await response.json().catch(() => undefined);
      if (response.status === 429 && this.throttled && attempt === 0) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(() => resolve(undefined), (seconds > 0 ? seconds : 60) * 1000));
        continue;
      }
      if (response.status >= 400) {
        throw new ForgejoRequestError(response.status, `${method} ${url}: ${errorMessage(data)}`);
      }
      return data;
    }
  }

  /** The API URL for `path` (which starts with "/") and `query`. */
  private apiUrl(path: string, query: Query): string {
    const params = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    return `${API_URL}${path}${params.length === 0 ? "" : `?${params.join("&")}`}`;
  }

  async get(path: string, query: Query = {}): Promise<unknown> {
    return this.fetchJson("GET", this.apiUrl(path, query));
  }

  /** GET every page of a list endpoint. */
  async getPaginated(path: string, query: Query = {}): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const data = await this.fetchJson("GET", this.apiUrl(path, { ...query, limit: PAGE_LIMIT, page }));
      if (!Array.isArray(data)) {
        throw new Error(`not a list endpoint: ${path}`);
      }
      items.push(...data);
      if (data.length < PAGE_LIMIT) {
        return items;
      }
    }
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson("POST", this.apiUrl(path, {}), body);
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson("PATCH", this.apiUrl(path, {}), body);
  }

  async delete(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson("DELETE", this.apiUrl(path, {}), body);
  }
}

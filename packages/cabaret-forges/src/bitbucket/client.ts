import { UserError } from "cabaret-core";

/** A repository on bitbucket.org, by workspace and repository slug. */
export interface BitbucketRepo {
  readonly workspace: string;
  readonly slug: string;
}

// The `origin` URL forms git itself uses for bitbucket.org: HTTPS (whose
// default clone URL carries the account as userinfo), scp-like SSH, and full
// SSH, each with or without `.git`.
const REMOTE_URL =
  /^(?:https:\/\/(?:[^@/]+@)?bitbucket\.org\/|git@bitbucket\.org:|ssh:\/\/git@bitbucket\.org\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Parse the repository a bitbucket.org remote URL names. Bitbucket treats
 * workspace and repository slugs case-insensitively, but `ForgeLocator`s (and
 * so the `source.forge` fields comment dedup compares) are matched
 * byte-for-byte — lowercasing makes every clone of one repository agree on
 * the locator no matter how its remote URL is spelled.
 */
export function parseBitbucketRemote(url: string): BitbucketRepo {
  const match = REMOTE_URL.exec(url);
  const workspace = match?.[1];
  const slug = match?.[2];
  if (workspace === undefined || slug === undefined) {
    throw new UserError(`not a bitbucket.org repository URL: ${JSON.stringify(url)}`);
  }
  return { workspace: workspace.toLowerCase(), slug: slug.toLowerCase() };
}

/** A failed Bitbucket API call, carrying the HTTP status that failed it. */
export class BitbucketRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a Bitbucket API rejection with HTTP `status`; anything else is a real failure. */
export function isStatus(error: unknown, status: number): boolean {
  return error instanceof BitbucketRequestError && error.status === status;
}

// This package compiles against bare es2025 to stay platform-agnostic, so the
// runtime-provided fetch, timer, and base64 encoder are declared rather than
// imported from a lib.
declare const fetch: (
  url: string,
  init: object,
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const btoa: (raw: string) => string;

const API_URL = "https://api.bitbucket.org/2.0";

// Bitbucket caps pull-request pages at 50 items; other endpoints allow more,
// but one size keeps every request within every cap.
const PAGE_LIMIT = 50;

/** GET query parameters, serialized in place; an array repeats its key. */
export type Query = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/**
 * How Bitbucket authenticates the calls: an Atlassian API token with the
 * account's email (HTTP basic), or a workspace or repository access token on
 * its own (bearer).
 */
export interface BitbucketAuth {
  readonly token: string;
  readonly email?: string | undefined;
}

/** The error text of a failed call's body: Bitbucket's `error.message`, whatever shape it takes. */
function errorMessage(data: unknown): string {
  const { error } = (data ?? {}) as { error?: unknown };
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === "string") {
    return message;
  }
  return typeof error === "string" ? error : (JSON.stringify(data) ?? "unknown error");
}

/**
 * An authenticated bitbucket.org API client over the runtime's `fetch`, so
 * the same client serves Node hosts and the browser. A rate limit (429) is
 * waited out once, but a second hit on the same call means something is
 * genuinely wrong, so it fails rather than keep hammering Bitbucket.
 *
 * `throttled: false` is for tests against canned responses, which would
 * otherwise wait out stubbed rate limits in real time.
 */
export class BitbucketClient {
  private readonly throttled: boolean;

  constructor(
    private readonly auth: BitbucketAuth,
    { throttled = true }: { readonly throttled?: boolean } = {},
  ) {
    this.throttled = throttled;
  }

  private authorization(): string {
    return this.auth.email === undefined
      ? `Bearer ${this.auth.token}`
      : `Basic ${btoa(`${this.auth.email}:${this.auth.token}`)}`;
  }

  private async fetchJson(method: string, url: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: this.authorization(),
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
        throw new BitbucketRequestError(response.status, `${method} ${url}: ${errorMessage(data)}`);
      }
      return data;
    }
  }

  /** The API URL for `path` (which starts with "/") and `query`. */
  private apiUrl(path: string, query: Query): string {
    const params = Object.entries(query).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((one: string | number | boolean) => {
        return `${key}=${encodeURIComponent(one)}`;
      }),
    );
    return `${API_URL}${path}${params.length === 0 ? "" : `?${params.join("&")}`}`;
  }

  async get(path: string, query: Query = {}): Promise<unknown> {
    return this.fetchJson("GET", this.apiUrl(path, query));
  }

  /** GET every page of a list endpoint, following Bitbucket's `next` links. */
  async getPaginated(path: string, query: Query = {}): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    let url: string | undefined = this.apiUrl(path, { ...query, pagelen: PAGE_LIMIT });
    while (url !== undefined) {
      const page = (await this.fetchJson("GET", url)) as { values?: unknown; next?: unknown };
      if (!Array.isArray(page.values)) {
        throw new Error(`not a list endpoint: ${path}`);
      }
      items.push(...page.values);
      url = typeof page.next === "string" ? page.next : undefined;
    }
    return items;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson("POST", this.apiUrl(path, {}), body);
  }

  async put(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson("PUT", this.apiUrl(path, {}), body);
  }
}

import { UserError } from "cabaret-core";

/**
 * A project on gitlab.com, by its full path — "group/project", with any
 * number of subgroup components between.
 */
export interface GitLabProject {
  readonly path: string;
}

// The `origin` URL forms git itself uses for gitlab.com: HTTPS, scp-like SSH,
// and full SSH, each with or without `.git`.
const REMOTE_URL =
  /^(?:https:\/\/gitlab\.com\/|git@gitlab\.com:|ssh:\/\/git@gitlab\.com\/)((?:[^/]+\/)+[^/]+?)(?:\.git)?\/?$/i;

/**
 * Parse the project a gitlab.com remote URL names. GitLab treats paths
 * case-insensitively, but `ForgeLocator`s (and so the `source.forge` fields
 * comment dedup compares) are matched byte-for-byte — lowercasing makes every
 * clone of one project agree on the locator no matter how its remote URL is
 * spelled.
 */
export function parseGitLabRemote(url: string): GitLabProject {
  const path = REMOTE_URL.exec(url)?.[1];
  if (path === undefined) {
    throw new UserError(`not a gitlab.com repository URL: ${JSON.stringify(url)}`);
  }
  return { path: path.toLowerCase() };
}

/** A failed GitLab API call, carrying the HTTP status that failed it. */
export class GitLabRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `error` is a GitLab API rejection with HTTP `status`; anything else is a real failure. */
export function isStatus(error: unknown, status: number): boolean {
  return error instanceof GitLabRequestError && error.status === status;
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

const REST_URL = "https://gitlab.com/api/v4";
const GRAPHQL_URL = "https://gitlab.com/api/graphql";

/** GET query parameters, serialized in place. */
export type Query = Readonly<Record<string, string | number | boolean>>;

/** The error text of a failed call's body: GitLab's `message` (or `error`), whatever shape it takes. */
function errorMessage(data: unknown): string {
  const { message, error } = (data ?? {}) as { message?: unknown; error?: unknown };
  const detail = message ?? error;
  return typeof detail === "string" ? detail : (JSON.stringify(detail ?? data) ?? "unknown error");
}

/**
 * An authenticated gitlab.com API client over the runtime's `fetch`, so the
 * same client serves Node hosts and the browser — which `cabaret-web`
 * requires. A rate limit (429) is waited out once, but a second hit on the
 * same call means something is genuinely wrong, so it fails rather than keep
 * hammering GitLab.
 *
 * `throttled: false` is for tests against canned responses, which would
 * otherwise wait out stubbed rate limits in real time.
 */
export class GitLabClient {
  private readonly throttled: boolean;

  constructor(
    private readonly token: string,
    { throttled = true }: { readonly throttled?: boolean } = {},
  ) {
    this.throttled = throttled;
  }

  private async fetchJson(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ readonly data: unknown; readonly nextPage: string | undefined }> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The browser would otherwise serve rereads after a write from its
        // HTTP cache for a minute — review state that appears to not stick.
        // Node's fetch never caches, so this only disciplines browsers.
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
        throw new GitLabRequestError(response.status, `${method} ${url}: ${errorMessage(data)}`);
      }
      return { data, nextPage: response.headers.get("x-next-page") || undefined };
    }
  }

  /** The REST URL for `path` (which starts with "/") and `query`. */
  private restUrl(path: string, query: Query): string {
    const params = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    return `${REST_URL}${path}${params.length === 0 ? "" : `?${params.join("&")}`}`;
  }

  async get(path: string, query: Query = {}): Promise<unknown> {
    return (await this.fetchJson("GET", this.restUrl(path, query))).data;
  }

  /** GET every page of a list endpoint, following GitLab's x-next-page header. */
  async getPaginated(path: string, query: Query = {}): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    for (let page = "1"; ; ) {
      const { data, nextPage } = await this.fetchJson("GET", this.restUrl(path, { ...query, per_page: 100, page }));
      if (!Array.isArray(data)) {
        throw new Error(`not a list endpoint: ${path}`);
      }
      items.push(...data);
      if (nextPage === undefined) {
        return items;
      }
      page = nextPage;
    }
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return (await this.fetchJson("POST", this.restUrl(path, {}), body)).data;
  }

  async put(path: string, body: unknown): Promise<unknown> {
    return (await this.fetchJson("PUT", this.restUrl(path, {}), body)).data;
  }

  /** Run a GraphQL query, returning its `data`; any GraphQL-level error fails the call. */
  async graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    const { data } = await this.fetchJson("POST", GRAPHQL_URL, { query, variables });
    const out = (data ?? {}) as { data?: unknown; errors?: readonly { message?: unknown }[] };
    if (out.errors !== undefined && out.errors.length > 0) {
      throw new Error(`GraphQL: ${out.errors.map(({ message }) => String(message)).join("; ")}`);
    }
    return out.data;
  }
}

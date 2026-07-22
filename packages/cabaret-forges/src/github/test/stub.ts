import { vi } from "vitest";

// Node provides the WHATWG `Response` octokit consumes; the class is absent
// from the bare es2025 lib this platform-agnostic package compiles against.
declare class Response {
  constructor(body: string, init: { status: number; headers: Readonly<Record<string, string>> });
}

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export interface Route {
  readonly status?: number;
  readonly link?: string;
  readonly json: unknown;
}

/**
 * Stub `fetch` with canned responses keyed by "METHOD url", recording every
 * request. A single route answers every call to its key; an array answers
 * them in order. An unrouted request fails as a 400 naming itself — a status
 * the retry plugin treats as final; a thrown error would surface as a
 * retryable 500, and the retries would outlive the stub and reach the real
 * GitHub.
 */
export function stubGitHub(routes: Readonly<Record<string, Route | readonly Route[]>>): Call[] {
  const calls: Call[] = [];
  const consumed = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ method: init.method, url, headers: init.headers, body: init.body });
      const key = `${init.method} ${url}`;
      const entry = routes[key];
      const index = consumed.get(key) ?? 0;
      consumed.set(key, index + 1);
      const route = (entry === undefined ? undefined : "json" in entry ? entry : entry[index]) ?? {
        status: 400,
        json: { message: `unrouted request: ${key}` },
      };
      return new Response(typeof route.json === "string" ? route.json : JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: {
          "content-type": typeof route.json === "string" ? "text/plain" : "application/json",
          ...(route.link === undefined ? {} : { link: route.link }),
        },
      });
    },
  );
  return calls;
}

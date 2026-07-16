import { vi } from "vitest";

// Node provides the WHATWG `Response` the client consumes; the class is
// absent from the bare es2025 lib this platform-agnostic package compiles
// against.
declare class Response {
  constructor(body: string | null, init: { status: number; headers: Readonly<Record<string, string>> });
}

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export interface Route {
  readonly status?: number;
  readonly json: unknown;
}

/**
 * Stub `fetch` with canned responses keyed by "METHOD url", recording every
 * request. A single route answers every call to its key; an array answers
 * them in order. An unrouted request fails as a 400 naming itself.
 */
export function stubForgejo(routes: Readonly<Record<string, Route | readonly Route[]>>): Call[] {
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
      const status = route.status ?? 200;
      // A 204 must carry no body, exactly as Forgejo answers a DELETE.
      return new Response(status === 204 ? null : JSON.stringify(route.json), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return calls;
}

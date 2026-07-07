import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * Static host for the built site plus the one thing a static site cannot do
 * itself: GitHub's OAuth code-for-token exchange, whose endpoint requires the
 * app's client secret and sends no CORS headers. The token goes back to the
 * page in a URL fragment, which never reaches a server or its logs.
 */

const { values: args } = parseArgs({
  options: {
    root: { type: "string", default: join(import.meta.dirname, "..", "site") },
    port: { type: "string", default: "8484" },
    bind: { type: "string", default: "127.0.0.1" },
    oauth: { type: "string", default: join(homedir(), ".config", "cabaret-web", "oauth.json") },
  },
});
const root = resolve(args.root);

/** The OAuth app's credentials, read per login so registering needs no restart. */
async function oauthApp(): Promise<{ clientId: string; clientSecret: string }> {
  let text: string;
  try {
    text = await readFile(args.oauth, "utf8");
  } catch {
    throw new Error(`no OAuth app configured: put {"clientId": ..., "clientSecret": ...} in ${args.oauth}`);
  }
  const parsed: unknown = JSON.parse(text);
  const { clientId, clientSecret } = parsed as { clientId?: unknown; clientSecret?: unknown };
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error(`malformed OAuth config: ${args.oauth} must hold string clientId and clientSecret`);
  }
  return { clientId, clientSecret };
}

// Outstanding `state` nonces: issued at login, spent at the callback. Bounds
// itself because each entry expires; a restart just makes logins in flight
// start over.
const states = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function freshState(): string {
  const state = crypto.randomUUID();
  const now = Date.now();
  for (const [key, at] of states) {
    if (now - at > STATE_TTL_MS) {
      states.delete(key);
    }
  }
  states.set(state, now);
  return state;
}

function spendState(state: string | null): boolean {
  if (state === null || !states.has(state)) {
    return false;
  }
  const at = states.get(state) as number;
  states.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}

/**
 * Redirect to GitHub's authorize page. No redirect_uri is passed, so GitHub
 * returns to the app's registered callback URL — which also keeps a visit
 * via the host's raw IP from manufacturing a mismatching redirect.
 */
async function login(res: ServerResponse): Promise<void> {
  const { clientId } = await oauthApp();
  const query = new URLSearchParams({ client_id: clientId, scope: "repo", state: freshState() });
  res.writeHead(302, { location: `https://github.com/login/oauth/authorize?${query}` }).end();
}

async function callback(res: ServerResponse, url: URL): Promise<void> {
  if (!spendState(url.searchParams.get("state"))) {
    throw new Error("login expired or did not start here; try signing in again");
  }
  const code = url.searchParams.get("code");
  if (code === null) {
    throw new Error(`GitHub reported: ${url.searchParams.get("error_description") ?? "no authorization code"}`);
  }
  const { clientId, clientSecret } = await oauthApp();
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = (await exchange.json()) as { access_token?: unknown; error_description?: unknown };
  if (typeof body.access_token !== "string") {
    throw new Error(`token exchange failed: ${String(body.error_description ?? exchange.status)}`);
  }
  res.writeHead(302, { location: `/#token=${encodeURIComponent(body.access_token)}` }).end();
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveFile(res: ServerResponse, pathname: string): Promise<void> {
  const path = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!path.startsWith(root)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://host");
  const handler =
    url.pathname === "/oauth/login"
      ? login(res)
      : url.pathname === "/oauth/callback"
        ? callback(res, url)
        : serveFile(res, url.pathname);
  handler.catch((error: unknown) => {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`cabaret: ${error instanceof Error ? error.message : String(error)}`);
  });
}).listen(Number(args.port), args.bind, () => {
  console.log(`serving ${root} on http://${args.bind}:${args.port}`);
});

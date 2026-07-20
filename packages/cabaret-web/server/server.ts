// Serves the built app and performs the OAuth code-for-token exchange, the
// one step that needs the client secret and a CORS-free origin. Everything
// else the app does talks to the GitHub API from the browser directly.
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8484);
const CLIENT_DIR = fileURLToPath(new URL("../client/", import.meta.url));
const OAUTH_PATH = join(homedir(), ".config", "cabaret-web", "oauth.json");

interface OauthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

async function oauthApp(): Promise<OauthApp> {
  const raw = JSON.parse(await readFile(OAUTH_PATH, "utf8")) as { clientId?: unknown; clientSecret?: unknown };
  const { clientId, clientSecret } = raw;
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || clientId === "" || clientSecret === "") {
    throw new Error(`${OAUTH_PATH} must hold nonempty "clientId" and "clientSecret" strings`);
  }
  return { clientId, clientSecret };
}

async function exchangeCode(app: OauthApp, code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  if (!response.ok) {
    throw new Error(`token exchange answered ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: unknown; error_description?: unknown; error?: unknown };
  if (typeof body.access_token !== "string") {
    throw new Error(String(body.error_description ?? body.error ?? "token exchange answered without a token"));
  }
  return body.access_token;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  if (relative.split(/[/\\]/).includes("..")) {
    response.writeHead(400).end("bad path");
    return;
  }
  const file = join(CLIENT_DIR, relative === "" ? "index.html" : relative);
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}

/**
 * The token returns to the page in a URL fragment: fragments never reach a
 * server, so it cannot land in a request log. The state nonce rides along
 * for the page to check against the one it minted.
 */
function tokenFragment(fields: Readonly<Record<string, string>>): string {
  return `/#${new URLSearchParams(fields)}`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const handle = async (): Promise<void> => {
    if (request.method !== "GET") {
      response.writeHead(405).end("method not allowed");
      return;
    }
    if (url.pathname === "/oauth/config") {
      const { clientId } = await oauthApp();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ clientId }));
      return;
    }
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      if (code === null) {
        response.writeHead(400).end("missing code");
        return;
      }
      let location: string;
      try {
        location = tokenFragment({ token: await exchangeCode(await oauthApp(), code), state });
      } catch (error) {
        location = tokenFragment({ error: error instanceof Error ? error.message : String(error), state });
      }
      response.writeHead(302, { location }).end();
      return;
    }
    await serveStatic(url.pathname, response);
  };
  handle().catch((error: unknown) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
  });
});

server.listen(PORT, () => {
  console.log(`cabaret-web serving on http://localhost:${PORT}`);
});

import { timestampMs } from "cabaret-core";
import { GitHubBackend, GitHubForge, githubClient, isStatus, type ObjectStore } from "cabaret-github";
import { markReviewed, renderPage } from "cabaret-views";
import { App, type Rendered, type Shell } from "./app.js";
import {
  type Config,
  clearToken,
  loadConfig,
  mintOauthState,
  parseRepo,
  postNotice,
  saveAliases,
  savedAliases,
  savedRepo,
  saveRepo,
  saveToken,
  takeNotice,
  takeOauthState,
} from "./config.js";
import { codeHighlighter } from "./highlight.js";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("missing #app");
}

/** What a sign-in redirect brought back in the URL fragment, if anything. */
function oauthReturn():
  | { token?: string | undefined; error?: string | undefined; state?: string | undefined }
  | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("token") && !params.has("error")) {
    return undefined;
  }
  return {
    token: params.get("token") ?? undefined,
    error: params.get("error") ?? undefined,
    state: params.get("state") ?? undefined,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: readonly (HTMLElement | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/**
 * The sign-in and repo picker screen. The token arrives either way the
 * deployment allows: the OAuth button when the local server answers for it,
 * or a pasted personal access token, which needs no server at all.
 */
function showSetup(shellRoot: HTMLElement, notice?: string): void {
  const noticeRow = el("p", { className: "notice", hidden: notice === undefined }, notice ?? "");
  const repoInput = el("input", {
    placeholder: "owner/repo or clone URL",
    value: savedRepo() ?? "",
    spellcheck: false,
  });
  const tokenInput = el("input", { type: "password", placeholder: "personal access token", spellcheck: false });
  const aliasInput = el("input", {
    placeholder: "you@example.com, …",
    value: savedAliases(),
    spellcheck: false,
  });
  const complain = (error: unknown): void => {
    noticeRow.textContent = error instanceof Error ? error.message : String(error);
    noticeRow.hidden = false;
  };
  const oauthButton = el("button", { type: "button", hidden: true }, "Sign in with GitHub");
  const form = el(
    "form",
    {},
    el("label", {}, "repository", repoInput),
    oauthButton,
    el("label", {}, "token", tokenInput),
    el("label", {}, "review identities (optional, comma-separated)", aliasInput),
    el("button", { type: "submit" }, "Start"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const repo = parseRepo(repoInput.value);
      if (tokenInput.value === "") {
        throw new Error("paste a token, or sign in with GitHub");
      }
      saveRepo(repo);
      saveToken(tokenInput.value);
      saveAliases(aliasInput.value);
      const config = loadConfig();
      if (config === undefined) {
        throw new Error("saved settings did not load back");
      }
      startApp(shellRoot, config);
    } catch (error) {
      complain(error);
    }
  });
  // The OAuth exchange needs the server's client secret; the button appears
  // only where a server is answering.
  void fetch("/oauth/config")
    .then(async (response) => {
      if (!response.ok) {
        return;
      }
      const { clientId } = (await response.json()) as { clientId: string };
      oauthButton.hidden = false;
      oauthButton.addEventListener("click", () => {
        // The whole path under the notice: a silent click is a dead end.
        try {
          saveRepo(parseRepo(repoInput.value));
          saveAliases(aliasInput.value);
          const query = new URLSearchParams({ client_id: clientId, scope: "repo", state: mintOauthState() });
          location.href = `https://github.com/login/oauth/authorize?${query}`;
        } catch (error) {
          complain(error);
        }
      });
    })
    .catch(() => undefined);
  shellRoot.replaceChildren(el("div", { className: "setup" }, el("h1", {}, "cabaret"), noticeRow, form));
}

/** Immutable git facts persisted across reloads; hash-pinned keys never go stale. */
function objectStore(repo: Config["repo"]): ObjectStore {
  const prefix = `cabaret-web.git.${repo.owner}/${repo.repo}.`;
  return {
    get: (key) => localStorage.getItem(prefix + key) ?? undefined,
    set: (key, value) => {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        // A full store just means less caching.
      }
    },
  };
}

/**
 * Declare the identities the logs may speak of the user by: their saved
 * aliases, plus the account's public email, mirroring what `cabaret fetch`
 * records in a checkout.
 */
async function seedAliases(backend: GitHubBackend, forge: GitHubForge, aliases: readonly string[]): Promise<void> {
  for (const alias of aliases) {
    await backend.configAdd("cabaret.alias", alias, "global");
  }
  try {
    for (const alias of (await forge.currentSelf()).aliases) {
      await backend.configAdd("cabaret.alias", alias, "global");
    }
  } catch {
    // The first render surfaces auth problems; profile aliases are best-effort.
  }
}

function startApp(shellRoot: HTMLElement, config: Config): void {
  const client = githubClient(config.token);
  const backend = new GitHubBackend(
    client,
    config.repo,
    objectStore(config.repo),
    // Unthrottled: the backend's GraphQL reads batch into a handful of
    // queries that must not queue behind the mutation pacing.
    githubClient(config.token, { throttled: false }),
  );
  const seeded = seedAliases(backend, new GitHubForge(client, config.repo), config.aliases);
  const shell: Shell = {
    content: el("div", { className: "content" }),
    status: el("div", { className: "status" }),
    overlay: el("div", { className: "overlay", hidden: true }),
  };
  shellRoot.replaceChildren(shell.content, shell.status, shell.overlay);
  const now = (): ReturnType<typeof timestampMs> => timestampMs(Date.now());
  // The highlighter paints grammars in as they arrive; the app exists by the
  // time any could load.
  let loaded = (): void => {};
  const highlighter = codeHighlighter(() => loaded());
  const app = new App(
    async (page): Promise<Rendered> => {
      await seeded;
      try {
        let snapshot: Rendered["snapshot"];
        let viewed: Rendered["viewed"];
        const doc = await renderPage(backend, page, {
          onSnapshot: (held) => {
            snapshot = held;
          },
          onViewed: (diffs) => {
            viewed = diffs;
          },
        });
        return { doc, snapshot, viewed };
      } catch (error) {
        if (isStatus(error, 401)) {
          clearToken();
          postNotice("GitHub rejected the token; sign in again");
          location.reload();
        }
        throw error;
      }
    },
    shell,
    {
      fetchOrigin: () => backend.fetchOrigin(),
      mark: (snapshot, file, evenThoughNotReviewing) =>
        Promise.resolve(markReviewed(backend, now, snapshot, file, evenThoughNotReviewing)),
    },
    highlighter,
  );
  loaded = () => app.repaint();
  app.start();
}

const returned = oauthReturn();
if (returned !== undefined) {
  const expected = takeOauthState();
  history.replaceState(null, "", location.pathname);
  if (returned.error !== undefined) {
    showSetup(root, `sign-in failed: ${returned.error}`);
  } else if (returned.token === undefined || expected === undefined || returned.state !== expected) {
    showSetup(root, "sign-in state mismatch; try again");
  } else {
    saveToken(returned.token);
    const config = loadConfig();
    if (config === undefined) {
      showSetup(root, "signed in — now pick a repository");
    } else {
      startApp(root, config);
    }
  }
} else {
  const config = loadConfig();
  if (config === undefined) {
    showSetup(root, takeNotice());
  } else {
    startApp(root, config);
  }
}

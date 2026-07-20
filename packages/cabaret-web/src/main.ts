import { GitHubBackend, githubClient, isStatus, type ObjectStore } from "cabaret-github";
import { renderPage } from "cabaret-views";
import { App, type Shell } from "./app.js";
import {
  type Config,
  clearToken,
  loadConfig,
  mintOauthState,
  parseRepo,
  postNotice,
  savedRepo,
  saveRepo,
  saveToken,
  takeNotice,
  takeOauthState,
} from "./config.js";

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
        try {
          saveRepo(parseRepo(repoInput.value));
        } catch (error) {
          complain(error);
          return;
        }
        const query = new URLSearchParams({ client_id: clientId, scope: "repo", state: mintOauthState() });
        location.href = `https://github.com/login/oauth/authorize?${query}`;
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

function startApp(shellRoot: HTMLElement, config: Config): void {
  const backend = new GitHubBackend(githubClient(config.token), config.repo, objectStore(config.repo));
  const shell: Shell = {
    content: el("div", { className: "content" }),
    status: el("div", { className: "status" }),
    overlay: el("div", { className: "overlay", hidden: true }),
  };
  shellRoot.replaceChildren(shell.content, shell.status, shell.overlay);
  const app = new App(
    async (page) => {
      try {
        return await renderPage(backend, page);
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
    () => backend.fetchOrigin(),
  );
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

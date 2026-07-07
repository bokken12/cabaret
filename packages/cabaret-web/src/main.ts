import { type GitHubRepo, githubClient } from "cabaret-github";
import { z } from "zod";
import { startApp } from "./app.js";
import { loadRepo, loadToken, parseRepo, saveRepo, saveToken } from "./config.js";

/**
 * The token the OAuth callback passed back in the fragment, if this load is
 * one. It travels as a fragment so it never reaches a server or its logs, and
 * it is scrubbed from the address bar (and history) before anything renders.
 */
function tokenFromFragment(): string | undefined {
  const match = /^#token=(.+)$/.exec(location.hash);
  if (match?.[1] === undefined) {
    return undefined;
  }
  history.replaceState(null, "", location.pathname);
  return decodeURIComponent(match[1]);
}

/** Sign in with GitHub, with pasting a token as the fallback for hosts without the OAuth helper. */
function renderSignIn(root: HTMLElement): void {
  root.replaceChildren();
  const page = document.createElement("div");
  page.className = "setup";

  const title = document.createElement("h1");
  title.textContent = "cabaret";

  const signIn = document.createElement("a");
  signIn.className = "sign-in";
  signIn.href = "/oauth/login";
  signIn.textContent = "Sign in with GitHub";

  const fallback = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "or paste an access token";
  const form = document.createElement("form");
  const tokenInput = document.createElement("input");
  tokenInput.name = "token";
  tokenInput.type = "password";
  tokenInput.placeholder = "ghp_…";
  tokenInput.required = true;
  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "The token needs read access to a repository, and write access to record reviews. " +
    "It is stored only in this browser and sent only to api.github.com.";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Open";
  form.append(tokenInput, note, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken(tokenInput.value.trim());
    void main(root);
  });
  fallback.append(summary, form);

  page.append(title, signIn, fallback);
  root.append(page);
}

const ReposSchema = z.array(
  z.object({
    full_name: z.string(),
    private: z.boolean(),
    description: z.string().nullable(),
  }),
);

/** Pick the repository to review from those the token can reach, most recently pushed first. */
async function renderRepoPicker(root: HTMLElement, token: string): Promise<void> {
  root.replaceChildren();
  const page = document.createElement("div");
  page.className = "setup";
  const title = document.createElement("h1");
  title.textContent = "cabaret";
  const prompt = document.createElement("p");
  prompt.className = "note";
  prompt.textContent = "Loading your repositories…";
  page.append(title, prompt);
  root.append(page);

  let repos: ReadonlyArray<{ full_name: string; private: boolean; description: string | null }>;
  try {
    repos = ReposSchema.parse(await githubClient(token).paginate("GET /user/repos", { sort: "pushed", per_page: 100 }));
  } catch (error) {
    prompt.textContent = `cabaret: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  prompt.textContent = "Pick a repository to review:";
  const filter = document.createElement("input");
  filter.placeholder = "filter";
  const list = document.createElement("div");
  list.className = "repo-list";
  const open = (repo: GitHubRepo): void => {
    saveRepo(repo);
    startApp(root, { repo, token });
  };
  const show = (): void => {
    const needle = filter.value.trim().toLowerCase();
    list.replaceChildren(
      ...repos
        .filter(({ full_name }) => full_name.toLowerCase().includes(needle))
        .map(({ full_name, private: isPrivate, description }) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "repo-row";
          const name = document.createElement("span");
          name.className = "target";
          name.textContent = full_name + (isPrivate ? " 🔒" : "");
          row.append(name);
          if (description !== null && description !== "") {
            const about = document.createElement("span");
            about.className = "note";
            about.textContent = ` — ${description}`;
            row.append(about);
          }
          row.addEventListener("click", () => open(parseRepo(full_name)));
          return row;
        }),
    );
  };
  filter.addEventListener("input", show);
  show();
  page.append(filter, list);
  filter.focus();
}

async function main(root: HTMLElement): Promise<void> {
  const fresh = tokenFromFragment();
  if (fresh !== undefined) {
    saveToken(fresh);
  }
  const token = fresh ?? loadToken();
  if (token === undefined) {
    renderSignIn(root);
    return;
  }
  const repo = loadRepo();
  if (repo === undefined) {
    await renderRepoPicker(root, token);
    return;
  }
  startApp(root, { repo, token });
}

const root = document.getElementById("app");
if (root === null) {
  throw new Error("no #app element to mount into");
}
void main(root);

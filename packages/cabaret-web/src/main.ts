import { startApp } from "./app.js";
import { type Config, loadConfig, parseRepo, saveConfig } from "./config.js";

/** Ask for the repository and a token, then hand off to the app. */
function renderSetup(root: HTMLElement): void {
  root.replaceChildren();
  const form = document.createElement("form");
  form.className = "setup";

  const title = document.createElement("h1");
  title.textContent = "cabaret";

  const repoLabel = document.createElement("label");
  repoLabel.textContent = "GitHub repository";
  const repoInput = document.createElement("input");
  repoInput.name = "repo";
  repoInput.placeholder = "owner/repo";
  repoInput.required = true;
  repoLabel.append(repoInput);

  const tokenLabel = document.createElement("label");
  tokenLabel.textContent = "Access token";
  const tokenInput = document.createElement("input");
  tokenInput.name = "token";
  tokenInput.type = "password";
  tokenInput.placeholder = "ghp_…";
  tokenInput.required = true;
  tokenLabel.append(tokenInput);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "The token needs read access to the repository, and write access to record reviews. " +
    "It is stored only in this browser and sent only to api.github.com.";

  const error = document.createElement("p");
  error.className = "error";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Open";

  form.append(title, repoLabel, tokenLabel, note, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const config: Config = { repo: parseRepo(repoInput.value), token: tokenInput.value.trim() };
      saveConfig(config);
      startApp(root, config);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  });
  root.append(form);
}

const root = document.getElementById("app");
if (root === null) {
  throw new Error("no #app element to mount into");
}
const config = loadConfig();
if (config === undefined) {
  renderSetup(root);
} else {
  startApp(root, config);
}

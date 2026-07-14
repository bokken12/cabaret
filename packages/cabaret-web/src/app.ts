import { type FilePath, type RefName, type TimestampMs, timestampMs } from "cabaret-core";
import { GitHubBackend, githubClient } from "cabaret-github";
import {
  cachedSnapshot,
  type Doc,
  markReviewed,
  type Page,
  pagePath,
  parsePagePath,
  renderPage,
  type SnapshotCache,
} from "cabaret-views";
import { type Config, clearConfig, clearRepo, loadContext } from "./config.js";
import { docHtml } from "./html.js";

const now = (): TimestampMs => timestampMs(Date.now());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The fragment addressing `page`. Percent and the characters `encodeURI`
 * escapes are encoded so `decodeURIComponent` inverts exactly; `/` and `:`
 * stay raw, keeping the fragment readable as the page path it is.
 */
function pageHash(page: Page): string {
  return `#${encodeURI(pagePath(page).replace(/%/g, "%25"))}`;
}

/** The page the fragment addresses; an empty fragment is the todo page. */
function pageFromHash(hash: string): Page {
  const raw = hash.replace(/^#/, "");
  return raw === "" ? { kind: "todo" } : parsePagePath(decodeURIComponent(raw));
}

function pageTitle(page: Page): string {
  switch (page.kind) {
    case "todo":
      return "cabaret: todo";
    case "show":
      return `cabaret: ${page.change}`;
    case "review":
      return `cabaret: review ${page.change}`;
    case "diff":
      return `cabaret: ${page.file} in ${page.change}`;
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

export function startApp(root: HTMLElement, config: Config): void {
  const client = githubClient(config.token);
  const backend = new GitHubBackend(client, config.repo);
  const repoName = `${config.repo.owner}/${config.repo.repo}`;

  root.replaceChildren();
  const header = document.createElement("header");
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = "#/todo";
  brand.textContent = "cabaret";
  const repoLabel = document.createElement("button");
  repoLabel.className = "repo";
  repoLabel.textContent = repoName;
  repoLabel.title = "Switch repository";
  repoLabel.addEventListener("click", () => {
    clearRepo();
    location.href = "/";
  });
  const actions = document.createElement("span");
  actions.className = "actions";
  const status = document.createElement("span");
  status.className = "status";
  const signOut = button("Sign out", () => {
    clearConfig();
    location.reload();
  });
  header.append(brand, repoLabel, actions, status, signOut);
  const main = document.createElement("main");
  main.className = "doc";
  root.append(header, main);

  let statusTimer: number | undefined;
  function notify(text: string): void {
    status.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, 8000);
  }

  // Track what is on screen so clicks hit-test against exactly it.
  let current: { readonly page: Page; readonly doc: Doc } | undefined;
  let seq = 0;
  // Marks whose append has not landed yet: leaving the page would drop them.
  let pendingMarks = 0;
  window.addEventListener("beforeunload", (event) => {
    if (pendingMarks > 0) {
      event.preventDefault();
    }
  });
  // One reading of each change under review, reused across its pages and
  // updated locally by marks: hopping file to file costs only the next
  // diff's contents. Held until review state is re-read on purpose — a
  // refresh, the todo page, a failed mark.
  const snapshots: SnapshotCache = new Map();

  async function render(): Promise<void> {
    const mine = ++seq;
    document.body.classList.add("busy");
    try {
      const page = pageFromHash(location.hash);
      if (page.kind === "todo") {
        // The overview must not trust held snapshots; visiting it is the
        // natural re-read point for everything under review. This app is a
        // viewer of the review state published to origin — importing open
        // forge changes is `cabaret gh pull`'s job, from a checkout.
        snapshots.clear();
      }
      const doc = await renderPage(backend, page, { cache: snapshots, context: loadContext() });
      if (mine !== seq) {
        return;
      }
      current = { page, doc };
      main.innerHTML = docHtml(doc);
      updateActions(page);
      document.title = pageTitle(page);
    } catch (error) {
      if (mine !== seq) {
        return;
      }
      current = undefined;
      main.textContent = `cabaret: ${message(error)}`;
      actions.replaceChildren(button("Refresh", () => void render()));
    } finally {
      if (mine === seq) {
        document.body.classList.remove("busy");
      }
    }
  }

  /** Navigate to `page`; re-render in place when already there, since no hashchange will fire. */
  function goto(page: Page): void {
    const before = location.hash;
    location.hash = pageHash(page);
    if (location.hash === before) {
      void render();
    }
  }

  function updateActions(page: Page): void {
    actions.replaceChildren();
    if (page.kind === "show") {
      actions.append(button("Review", () => goto({ kind: "review", change: page.change })));
    } else if (page.kind === "diff") {
      actions.append(button("Mark reviewed", () => void runMarkReviewed(page.change, page.file)));
    }
    actions.append(
      button("Refresh", () => {
        if (page.kind !== "todo") {
          snapshots.delete(page.change);
        }
        void render();
      }),
    );
  }

  async function runMarkReviewed(change: RefName, file: FilePath): Promise<void> {
    try {
      const result = markReviewed(backend, now, await cachedSnapshot(backend, change, snapshots), file);
      if (result.kind === "nothing-left") {
        notify(`nothing left to review in ${file}`);
        return;
      }
      // Every following page renders from the marked-off snapshot, so the
      // hop — next diff or the round's review page — needs no re-read; a
      // failed append resurfaces here, where dropping the snapshot and
      // re-rendering shows the file as the log has it.
      snapshots.set(change, Promise.resolve(result.snapshot));
      pendingMarks++;
      result.recorded
        .catch((error: unknown) => {
          notify(`marking ${file} failed: ${message(error)}`);
          snapshots.delete(change);
          void render();
        })
        .finally(() => {
          pendingMarks--;
        });
      goto(result.next === undefined ? { kind: "review", change } : { kind: "diff", change, file: result.next });
    } catch (error) {
      notify(message(error));
    }
  }

  // Only a link span answers a click, not the rest of its line; location
  // targets are jump tier, so no case here follows one.
  main.addEventListener("click", (event) => {
    const linked = (event.target as Element | null)?.closest("[data-span]");
    const line = linked?.closest("[data-line]");
    if (!(linked instanceof HTMLElement) || !(line instanceof HTMLElement) || current === undefined) {
      return;
    }
    const target = current.doc.lines[Number(line.dataset.line)]?.spans[Number(linked.dataset.span)]?.target;
    if (target === undefined) {
      return;
    }
    switch (target.kind) {
      case "change":
        goto({ kind: "show", change: target.change });
        break;
      case "file":
        goto({ kind: "diff", change: target.change, file: target.file });
        break;
    }
  });

  window.addEventListener("hashchange", () => void render());
  void render();
}

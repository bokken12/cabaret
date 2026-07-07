import type { Backend, Forge } from "cabaret-core";
import type { Doc } from "./doc.js";
import type { Page } from "./pages.js";
import { diffDoc, diffPage, reviewDoc, reviewPage } from "./review.js";
import { showDoc, showPage } from "./show.js";
import { todoDoc, todoPage } from "./todo.js";

/**
 * Query `backend` and render `page` for its current user. `forge` is opened
 * lazily: only the todo page and a logless show page query it.
 */
export async function renderPage(backend: Backend, page: Page, forge: () => Promise<Forge | undefined>): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, await backend.currentUser(), await forge()));
    case "show":
      return showDoc(await showPage(backend, await backend.currentUser(), page.change, forge));
    case "review":
      return reviewDoc(await reviewPage(backend, await backend.currentUser(), page.change));
    case "diff":
      return diffDoc(await diffPage(backend, await backend.currentUser(), page.change, page.file));
  }
}

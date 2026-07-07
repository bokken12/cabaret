import { type Backend, type Forge, summarizeChange } from "cabaret-core";
import { type Doc, diffDoc, diffPage, reviewDoc, reviewPage, showDoc, todoDoc, todoPage } from "cabaret-views";
import type { Page } from "./pages.js";

/**
 * Query `backend` and render `page` for its current user. `forge` is opened
 * lazily: only the todo page queries it.
 */
export async function renderPage(backend: Backend, page: Page, forge: () => Promise<Forge | undefined>): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, await backend.currentUser(), await forge()));
    case "show":
      return showDoc(
        await summarizeChange(backend, page.change, await backend.readLog(page.change), await backend.currentUser()),
      );
    case "review":
      return reviewDoc(await reviewPage(backend, await backend.currentUser(), page.change));
    case "diff":
      return diffDoc(await diffPage(backend, await backend.currentUser(), page.change, page.file));
  }
}

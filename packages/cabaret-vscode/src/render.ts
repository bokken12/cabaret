import { type Backend, summarizeChange } from "cabaret-core";
import { type Doc, showDoc, todoDoc, todoPage } from "cabaret-views";
import type { Page } from "./pages.js";

/** Query `backend` and render `page` for its current user. */
export async function renderPage(backend: Backend, page: Page): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, await backend.currentUser()));
    case "show":
      return showDoc(
        await summarizeChange(backend, page.change, await backend.readLog(page.change), await backend.currentUser()),
      );
  }
}

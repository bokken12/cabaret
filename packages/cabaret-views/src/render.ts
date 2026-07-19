import { type Backend, currentSelf } from "cabaret-core";
import type { Doc } from "./doc.js";
import type { Page } from "./pages.js";
import { changeSnapshot, diffDoc, diffPage, reviewDoc, reviewPage } from "./review.js";
import { showDoc, showPage } from "./show.js";
import { todoDoc, todoPage } from "./todo.js";

/** What a host brings to a render beyond the page itself. */
export interface RenderOptions {
  /** Lines of context around diff hunks; `defaultContext` when unset, -1 for whole files. */
  readonly context?: number | undefined;
}

/**
 * Query `backend` and render `page` for its current user. Rendering reads
 * change logs alone — it never calls the forge.
 */
export async function renderPage(backend: Backend, page: Page, options: RenderOptions = {}): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, await currentSelf(backend)));
    case "show":
      return showDoc(await showPage(backend, await backend.currentUser(), page.change));
    case "review":
      return reviewDoc(reviewPage(await changeSnapshot(backend, page.change, page.as)));
    case "diff":
      return diffDoc(
        await diffPage(backend, await changeSnapshot(backend, page.change, page.as), page.file),
        options.context,
      );
  }
}

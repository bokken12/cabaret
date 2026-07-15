import { type Backend, currentSelf, type RefName } from "cabaret-core";
import type { Doc } from "./doc.js";
import type { Page } from "./pages.js";
import { type ChangeSnapshot, changeSnapshot, diffDoc, diffPage, reviewDoc, reviewPage } from "./review.js";
import { showDoc, showPage } from "./show.js";
import { todoDoc, todoPage } from "./todo.js";

/**
 * Snapshots a host is holding onto, keyed by change. The host owns the
 * lifetime: entries live until it decides the review state should be re-read
 * (a refresh, a failed mark, leaving the change).
 */
export type SnapshotCache = Map<RefName, Promise<ChangeSnapshot>>;

/** The cached snapshot of `change`, taking and remembering one when absent; with no cache, always fresh. */
export function cachedSnapshot(backend: Backend, change: RefName, cache?: SnapshotCache): Promise<ChangeSnapshot> {
  const held = cache?.get(change);
  if (held !== undefined) {
    return held;
  }
  const fresh = changeSnapshot(backend, change);
  if (cache !== undefined) {
    cache.set(change, fresh);
    // A failed read is not review state; drop it so the next ask retries.
    fresh.catch(() => cache.delete(change));
  }
  return fresh;
}

/** What a host brings to a render beyond the page itself. */
export interface RenderOptions {
  /** Lines of context around diff hunks; `defaultContext` when unset, -1 for whole files. */
  readonly context?: number | undefined;
  /** Held snapshots for the review and diff pages to render from; always fresh when absent. */
  readonly cache?: SnapshotCache | undefined;
}

/**
 * Query `backend` and render `page` for its current user. Rendering reads
 * change logs alone — it never calls the forge. The review and diff pages
 * render from the change's snapshot in `options.cache` when one is held,
 * letting a host reuse one reading across a whole review pass.
 */
export async function renderPage(backend: Backend, page: Page, options: RenderOptions = {}): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, await currentSelf(backend)));
    case "show":
      return showDoc(await showPage(backend, await backend.currentUser(), page.change));
    case "review":
      return reviewDoc(reviewPage(await cachedSnapshot(backend, page.change, options.cache)));
    case "diff":
      return diffDoc(
        await diffPage(backend, await cachedSnapshot(backend, page.change, options.cache), page.file),
        options.context,
      );
  }
}

import type { Backend, ChangeName, FilePath, Revision, UserName } from "cabaret-core";
import type { Doc } from "./doc.js";
import { type Hints, hintFooter } from "./hints.js";
import type { Page } from "./pages.js";
import { changeSnapshot, diffDoc, diffPage, diffsDoc, diffsPage, reviewDoc, reviewPage } from "./review.js";
import { showDoc, showPage } from "./show.js";
import { todoDoc, todoPage } from "./todo.js";

/**
 * The diffs a render displayed: evidence a host records so `mark`'s viewed
 * check can credit the display. Listing files (the review page) is not
 * viewing; only rendered diffs report.
 */
export interface ViewedDiffs {
  readonly change: ChangeName;
  /** Whose review the diffs showed: the snapshot's user, borrowed or not. */
  readonly user: UserName;
  readonly base: Revision;
  /** Per displayed file, the revision its diff was rendered up to. */
  readonly files: ReadonlyMap<FilePath, Revision>;
}

/** What a host brings to a render beyond the page itself. */
export interface RenderOptions {
  /** Lines of context around diff hunks; `defaultContext` when unset, -1 for whole files. */
  readonly context?: number | undefined;
  /** Key hints to show on the page, for a host whose keys are still unfamiliar. */
  readonly hints?: Hints | undefined;
  /** Called when the render displayed diffs, with what they showed. */
  readonly onViewed?: ((viewed: ViewedDiffs) => void) | undefined;
}

/**
 * Query `backend` and render `page` for its user — the current one, or the
 * identity the page borrows. Rendering reads change logs alone — it never
 * calls the forge.
 */
export async function renderPage(backend: Backend, page: Page, options: RenderOptions = {}): Promise<Doc> {
  const doc = await pageDoc(backend, page, options);
  const footer = hintFooter(options.hints);
  return footer.length === 0 ? doc : { ...doc, lines: [...doc.lines, ...footer] };
}

async function pageDoc(backend: Backend, page: Page, options: RenderOptions): Promise<Doc> {
  switch (page.kind) {
    case "todo":
      return todoDoc(await todoPage(backend, page.as), options.hints);
    case "show":
      return showDoc(await showPage(backend, page.change, page.as), options.hints);
    case "review":
      return reviewDoc(reviewPage(await changeSnapshot(backend, page.change, page.as)));
    case "diffs": {
      const snapshot = await changeSnapshot(backend, page.change, page.as);
      const diffs = await diffsPage(backend, snapshot);
      if (diffs.round !== undefined) {
        const { end, files } = diffs.round;
        options.onViewed?.({
          change: snapshot.change,
          user: snapshot.user,
          base: snapshot.base,
          files: new Map(files.map(({ file }) => [file, end])),
        });
      }
      return diffsDoc(diffs, options.context);
    }
    case "diff": {
      const snapshot = await changeSnapshot(backend, page.change, page.as);
      const file = await diffPage(backend, snapshot, page.file);
      if (file.round !== undefined) {
        options.onViewed?.({
          change: snapshot.change,
          user: snapshot.user,
          base: snapshot.base,
          files: new Map([[page.file, file.round.end]]),
        });
      }
      return diffDoc(file, options.context);
    }
  }
}

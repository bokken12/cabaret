import type { Backend, ChangeName, FilePath, Revision, TimestampMs, UserName } from "cabaret-core";
import type { Doc } from "./doc.js";
import { homeDoc, homePage } from "./home.js";
import type { Page } from "./pages.js";
import {
  type ChangeSnapshot,
  changeSnapshot,
  diffDoc,
  diffPage,
  diffsDoc,
  diffsPage,
  reviewDoc,
  reviewPage,
} from "./review.js";
import { showDoc, showPage } from "./show.js";

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

/** The key under which hosts record one file's diff as displayed to one user against one base. */
export function displayedKey(change: ChangeName, user: UserName, base: Revision, file: FilePath): string {
  return [change, user, base, file].join("\u0000");
}

/** What a host brings to a render beyond the page itself. */
export interface RenderOptions {
  /** The host's clock, read when a page dates what it shows. */
  readonly now: () => TimestampMs;
  /** Lines of context around diff hunks; `defaultContext` when unset, -1 for whole files. */
  readonly context?: number | undefined;
  /** Called when the render displayed diffs, with what they showed. */
  readonly onViewed?: ((viewed: ViewedDiffs) => void) | undefined;
  /**
   * Called with the snapshot a review, diffs, or diff page rendered from. A
   * host holds it beside the page, so a mark of the page records what it
   * displayed rather than whatever the change holds by then.
   */
  readonly onSnapshot?: ((snapshot: ChangeSnapshot) => void) | undefined;
}

/**
 * Query `backend` and render `page` for its user — the current one, or the
 * identity the page borrows. Rendering reads change logs alone — it never
 * calls the forge.
 */
export async function renderPage(backend: Backend, page: Page, options: RenderOptions): Promise<Doc> {
  switch (page.kind) {
    case "home":
      return homeDoc(await homePage(backend, page.as), options.now());
    case "show":
      return showDoc(await showPage(backend, page.change, page.as), options.now());
    case "review": {
      const snapshot = await changeSnapshot(backend, page.change, page.as);
      options.onSnapshot?.(snapshot);
      return reviewDoc(reviewPage(snapshot));
    }
    case "diffs": {
      const snapshot = await changeSnapshot(backend, page.change, page.as);
      options.onSnapshot?.(snapshot);
      const diffs = await diffsPage(backend, snapshot);
      if (diffs.left !== undefined) {
        const { tip, files } = diffs.left;
        options.onViewed?.({
          change: snapshot.change,
          user: snapshot.user,
          base: snapshot.base,
          files: new Map(files.map(({ file }) => [file, tip])),
        });
      }
      return diffsDoc(diffs, options.context);
    }
    case "diff": {
      const snapshot = await changeSnapshot(backend, page.change, page.as);
      options.onSnapshot?.(snapshot);
      const file = await diffPage(backend, snapshot, page.file);
      if (file.left !== undefined) {
        options.onViewed?.({
          change: snapshot.change,
          user: snapshot.user,
          base: snapshot.base,
          files: new Map([[page.file, file.left.tip]]),
        });
      }
      return diffDoc(file, options.context);
    }
  }
}

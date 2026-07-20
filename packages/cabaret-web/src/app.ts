import { type FilePath, NotReviewingError, type Revision } from "cabaret-core";
import {
  type ChangeSnapshot,
  type Doc,
  displayedKey,
  enclosingPage,
  type MarkReviewedResult,
  type Page,
  pagePath,
  pendingRound,
  targetAt,
  type ViewedDiffs,
} from "cabaret-views";
import { type Followed, followTarget } from "./follow.js";
import type { CodeHighlighter } from "./highlight.js";
import { foldAt, renderContent, visibleLines } from "./html.js";
import { bindingsFor, type Command } from "./keymap.js";
import { keyName } from "./keys.js";
import { currentHash, pageFromHash, pageHash } from "./router.js";

/** The elements the app paints into: the scrolling content, the status row, the help overlay. */
export interface Shell {
  readonly content: HTMLElement;
  readonly status: HTMLElement;
  readonly overlay: HTMLElement;
}

/** What a render of one page produced. */
export interface Rendered {
  readonly doc: Doc;
  /**
   * The snapshot a review, diffs, or diff render read, held beside the page
   * so a mark records what was displayed rather than whatever the change
   * holds by then.
   */
  readonly snapshot?: ChangeSnapshot | undefined;
  /** The diffs the render displayed: evidence for mark's viewed check. */
  readonly viewed?: ViewedDiffs | undefined;
}

/** Effects behind actions the app cannot serve from docs alone. */
export interface Effects {
  fetchOrigin(): Promise<void>;
  /** Record `file` of `snapshot`'s change reviewed. */
  mark(snapshot: ChangeSnapshot, file: FilePath, evenThoughNotReviewing: boolean): Promise<MarkReviewedResult>;
}

interface View {
  readonly page: Page;
  doc: Doc;
  snapshot: ChangeSnapshot | undefined;
  readonly folded: Set<number>;
  /** The cursor, as an index into the visible-line list. */
  cursor: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The web host's state: the current page with its folds and cursor, and the
 * note the status row shows. The browser holds the page stack — the location
 * hash is the page path, so back/forward and links all arrive as hash
 * changes. Every render is a network read; a failed one keeps the old page
 * visible and reports on the status row.
 */
export class App {
  private view: View | undefined;
  private note: string | undefined;
  private noteIsError = false;
  /** The chord keys pressed so far, awaiting the stroke that completes a binding. */
  private pending: string[] = [];
  /** Stamps each show; a render landing after a newer one started is dropped. */
  private epoch = 0;
  /** Per displayed diff, the revisions it was rendered up to — mark's viewed evidence. */
  private readonly displayedEnds = new Map<string, Set<Revision>>();

  constructor(
    private readonly source: (page: Page) => Promise<Rendered>,
    private readonly shell: Shell,
    private readonly effects: Effects,
    private readonly highlighter?: CodeHighlighter,
  ) {}

  /** Paint the current page again — for a grammar arriving after its first render. */
  repaint(): void {
    this.paint();
  }

  start(): void {
    window.addEventListener("hashchange", () => void this.showHash());
    window.addEventListener("keydown", (event) => this.handleKey(event));
    this.shell.content.addEventListener("click", (event) => this.handleClick(event));
    this.shell.overlay.addEventListener("click", () => this.hideOverlay());
    void this.showHash();
  }

  private async showHash(): Promise<void> {
    let page: Page;
    try {
      page = pageFromHash(currentHash(location.href));
    } catch (error) {
      this.setNote(message(error), true);
      page = { kind: "home" };
    }
    await this.show(page);
  }

  private recordViewed(viewed: ViewedDiffs | undefined): void {
    if (viewed === undefined) {
      return;
    }
    for (const [file, end] of viewed.files) {
      const key = displayedKey(viewed.change, viewed.user, viewed.base, file);
      const ends = this.displayedEnds.get(key) ?? new Set<Revision>();
      ends.add(end);
      this.displayedEnds.set(key, ends);
    }
  }

  private async show(page: Page): Promise<void> {
    const epoch = ++this.epoch;
    this.pending = [];
    this.setNote("loading…");
    let rendered: Rendered;
    try {
      rendered = await this.source(page);
    } catch (error) {
      if (epoch === this.epoch) {
        this.setNote(message(error), true);
      }
      return;
    }
    if (epoch !== this.epoch) {
      return;
    }
    this.recordViewed(rendered.viewed);
    this.view = { page, doc: rendered.doc, snapshot: rendered.snapshot, folded: new Set(), cursor: 0 };
    this.noteErrors(rendered.doc);
    this.paint();
  }

  /** Re-render the current page in place, keeping its folds and cursor. */
  private async refresh(report?: string): Promise<void> {
    const view = this.view;
    if (view === undefined) {
      return this.showHash();
    }
    const epoch = ++this.epoch;
    this.setNote("loading…");
    let rendered: Rendered;
    try {
      rendered = await this.source(view.page);
    } catch (error) {
      if (epoch === this.epoch) {
        this.setNote(message(error), true);
      }
      return;
    }
    if (epoch !== this.epoch) {
      return;
    }
    this.recordViewed(rendered.viewed);
    const doc = rendered.doc;
    view.doc = doc;
    view.snapshot = rendered.snapshot;
    const starts = new Set(doc.folds.map(({ start }) => start));
    for (const start of view.folded) {
      if (!starts.has(start)) {
        view.folded.delete(start);
      }
    }
    view.cursor = Math.min(view.cursor, Math.max(0, visibleLines(doc, view.folded).length - 1));
    this.note = report;
    this.noteIsError = false;
    this.noteErrors(doc);
    this.paint();
  }

  private noteErrors(doc: Doc): void {
    if (doc.errors.length > 0) {
      this.setNote(doc.errors.join("; "), true);
    }
  }

  private setNote(text: string | undefined, isError = false): void {
    this.note = text;
    this.noteIsError = isError;
    this.paintStatus();
  }

  private paint(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    this.shell.content.innerHTML = renderContent(view.doc, view.folded, this.highlighter);
    this.placeCursor();
    this.paintStatus();
  }

  private paintStatus(): void {
    this.shell.status.textContent = this.note ?? (this.view === undefined ? "" : pagePath(this.view.page));
    this.shell.status.classList.toggle("error", this.noteIsError);
  }

  private placeCursor(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    for (const marked of this.shell.content.querySelectorAll(".cursor")) {
      marked.classList.remove("cursor");
    }
    const row = this.shell.content.children[view.cursor];
    if (row !== undefined) {
      row.classList.add("cursor");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  private moveCursor(view: View, delta: number): void {
    const visible = visibleLines(view.doc, view.folded);
    view.cursor = Math.min(Math.max(view.cursor + delta, 0), Math.max(0, visible.length - 1));
    this.placeCursor();
  }

  /** Content rows in half the viewport, for ctrl+d and friends. */
  private halfPage(): number {
    const row = this.shell.content.firstElementChild;
    const rowHeight = row === null ? 20 : Math.max(1, row.getBoundingClientRect().height);
    return Math.max(1, Math.floor(this.shell.content.clientHeight / rowHeight / 2));
  }

  /** One character cell, the horizontal scroll step. */
  private charWidth(): number {
    const probe = document.createElement("span");
    probe.textContent = "0";
    this.shell.content.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return Math.max(1, width);
  }

  private handleKey(event: KeyboardEvent): void {
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      return;
    }
    if (!this.shell.overlay.hidden) {
      event.preventDefault();
      this.hideOverlay();
      return;
    }
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const name = keyName(event);
    if (name === undefined) {
      return;
    }
    if (name === "esc" && this.pending.length > 0) {
      event.preventDefault();
      this.pending = [];
      this.setNote(undefined);
      return;
    }
    const attempt = [...this.pending, name];
    const matches = bindingsFor(view.page.kind).filter((binding) => attempt.every((key, i) => binding.keys[i] === key));
    const exact = matches.find((binding) => binding.keys.length === attempt.length);
    if (exact !== undefined) {
      event.preventDefault();
      this.pending = [];
      this.setNote(undefined);
      void this.run(exact.command, view);
      return;
    }
    if (matches.length > 0) {
      event.preventDefault();
      this.pending = attempt;
      this.setNote(attempt.join(" "));
      return;
    }
    if (this.pending.length > 0) {
      event.preventDefault();
      this.pending = [];
      this.setNote(`${attempt.join(" ")} is undefined`);
      return;
    }
    // An unbound lone key stays the browser's.
  }

  private async run(command: Command, view: View): Promise<void> {
    switch (command) {
      case "open-target": {
        const line = visibleLines(view.doc, view.folded)[view.cursor];
        const target = line === undefined ? undefined : targetAt(view.doc, line);
        if (target !== undefined) {
          this.follow(followTarget(target));
        }
        return;
      }
      case "toggle-fold": {
        const line = visibleLines(view.doc, view.folded)[view.cursor];
        const fold = line === undefined ? undefined : foldAt(view.doc, line);
        if (fold !== undefined) {
          this.toggleFold(view, fold.start);
        }
        return;
      }
      case "back":
        history.back();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "fetch":
        this.setNote("fetching…");
        try {
          await this.effects.fetchOrigin();
        } catch (error) {
          this.setNote(message(error), true);
          return;
        }
        await this.refresh("fetched");
        return;
      case "mark":
        await this.markAtCursor(view);
        return;
      case "help":
        this.showOverlay(view);
        return;
      case "review":
        if (view.page.kind === "show") {
          location.hash = pageHash({ kind: "review", change: view.page.change, as: view.page.as });
        }
        return;
      case "diffs":
        if (view.page.kind === "show" || view.page.kind === "review") {
          location.hash = pageHash({ kind: "diffs", change: view.page.change, as: view.page.as });
        }
        return;
      case "step-outside": {
        const outer = enclosingPage(view.page);
        if (outer !== undefined) {
          location.hash = pageHash(outer);
        }
        return;
      }
      case "up":
        this.moveCursor(view, -1);
        return;
      case "down":
        this.moveCursor(view, 1);
        return;
      case "left":
        this.shell.content.scrollLeft -= this.charWidth();
        return;
      case "right":
        this.shell.content.scrollLeft += this.charWidth();
        return;
      case "half-up":
        this.moveCursor(view, -this.halfPage());
        return;
      case "half-down":
        this.moveCursor(view, this.halfPage());
        return;
      case "top":
        this.moveCursor(view, Number.MIN_SAFE_INTEGER);
        return;
      case "bottom":
        this.moveCursor(view, Number.MAX_SAFE_INTEGER);
        return;
    }
  }

  /**
   * Mark reviewed: on a diff page the file shown, on the review page the
   * file the cursor's line resolves to. Marking as a borrowed identity, a
   * never-displayed diff, and reviewing that excludes the user each confirm
   * first, mirroring the mark command's overrides.
   */
  private async markAtCursor(view: View): Promise<void> {
    const page = view.page;
    let file: FilePath;
    if (page.kind === "diff") {
      file = page.file;
    } else if (page.kind === "review") {
      const line = visibleLines(view.doc, view.folded)[view.cursor];
      const target = line === undefined ? undefined : targetAt(view.doc, line);
      if (target?.kind !== "file") {
        this.setNote("no file at the cursor");
        return;
      }
      file = target.file;
    } else {
      return;
    }
    const snapshot = view.snapshot;
    if (snapshot === undefined) {
      this.setNote("the page rendered without its review state; refresh first");
      return;
    }
    // The entry will carry the borrowed identity's name, so nothing here
    // may happen on muscle memory alone.
    if (page.as !== undefined && !confirm(`Mark ${file} reviewed as ${page.as}?`)) {
      return;
    }
    const pending = pendingRound(snapshot.rounds, file);
    if (
      pending !== undefined &&
      !this.displayedEnds.get(displayedKey(snapshot.change, snapshot.user, snapshot.base, file))?.has(pending.end) &&
      !confirm(`The diff of ${file} has not been displayed to ${page.as ?? "you"}. Mark anyway?`)
    ) {
      return;
    }
    await this.recordMark(view, snapshot, file, false);
  }

  private async recordMark(
    view: View,
    snapshot: ChangeSnapshot,
    file: FilePath,
    evenThoughNotReviewing: boolean,
  ): Promise<void> {
    let result: MarkReviewedResult;
    try {
      result = await this.effects.mark(snapshot, file, evenThoughNotReviewing);
    } catch (error) {
      if (error instanceof NotReviewingError) {
        const whom = view.page.as === undefined ? "you" : error.user;
        if (
          confirm(`${snapshot.change} is reviewing ${error.reviewing}, which does not include ${whom}. Mark anyway?`)
        ) {
          await this.recordMark(view, snapshot, file, true);
        }
        return;
      }
      this.setNote(message(error), true);
      return;
    }
    if (result.kind === "nothing-left") {
      this.setNote(`nothing left to review in ${file}`);
      return;
    }
    try {
      await result.recorded;
    } catch (error) {
      this.setNote(message(error), true);
      return;
    }
    if (view.page.kind === "diff") {
      // The marked page has served its purpose: move on to the round's next
      // file, or back to the review page when the round is done.
      const outer: Page = { kind: "review", change: snapshot.change, as: view.page.as };
      const next: Page =
        result.next === undefined
          ? outer
          : { kind: "diff", change: snapshot.change, file: result.next, as: view.page.as };
      const hash = pageHash(next);
      if (currentHash(location.href) === hash) {
        await this.refresh(`marked ${file}`);
      } else {
        location.hash = hash;
      }
      return;
    }
    await this.refresh(`marked ${file}`);
  }

  private toggleFold(view: View, start: number): void {
    if (!view.folded.delete(start)) {
      view.folded.add(start);
      view.cursor = visibleLines(view.doc, view.folded).indexOf(start);
    }
    this.shell.content.innerHTML = renderContent(view.doc, view.folded, this.highlighter);
    this.placeCursor();
  }

  private follow(followed: Followed): void {
    switch (followed.kind) {
      case "page":
        location.hash = pageHash(followed.page);
        return;
      case "external":
        window.open(followed.url, "_blank", "noopener");
        return;
      case "note":
        this.setNote(followed.text);
        return;
    }
  }

  private handleClick(event: MouseEvent): void {
    const view = this.view;
    if (view === undefined || !(event.target instanceof Element)) {
      return;
    }
    const row = event.target.closest(".line");
    if (row instanceof HTMLElement) {
      const index = Array.prototype.indexOf.call(this.shell.content.children, row);
      if (index !== -1) {
        view.cursor = index;
        this.placeCursor();
      }
    }
    if (event.target.closest(".fold-mark") !== null && row instanceof HTMLElement) {
      const line = Number(row.dataset.line);
      const fold = foldAt(view.doc, line);
      if (fold !== undefined) {
        event.preventDefault();
        this.toggleFold(view, fold.start);
      }
      return;
    }
    const note = event.target.closest("[data-note]")?.getAttribute("data-note");
    if (note !== null && note !== undefined) {
      event.preventDefault();
      this.setNote(note);
    }
  }

  private showOverlay(view: View): void {
    const bindings = bindingsFor(view.page.kind);
    const rows = bindings.map(({ keys, label }) => `<tr><td>${keys.join(" ")}</td><td>${label}</td></tr>`).join("\n");
    this.shell.overlay.innerHTML =
      `<div class="help"><p>Keys on this page (any key dismisses)</p><table>${rows}</table>` +
      `<p class="dim">Change actions (rebase, land, …) run from a host with a checkout: the CLI, VS Code, or the TUI.</p></div>`;
    this.shell.overlay.hidden = false;
  }

  private hideOverlay(): void {
    this.shell.overlay.hidden = true;
  }
}

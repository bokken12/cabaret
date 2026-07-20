import { type ChangeName, type FilePath, NotReviewingError, type Revision } from "cabaret-core";
import {
  type ChangeSnapshot,
  type Doc,
  displayedKey,
  type MarkReviewedResult,
  type Page,
  pagePath,
  pendingRound,
  type Target,
  targetAt,
  type ViewedDiffs,
} from "cabaret-views";
import { bindingsFor, type Command } from "./keymap.js";
import { type ColorDepth, foldAt, paintPage, paintStatus, visibleLines } from "./paint.js";

/** What the app draws frames on. */
export interface Terminal {
  columns(): number;
  rows(): number;
  readonly depth: ColorDepth;
  /** Display a full frame: content rows then the status row. */
  render(rows: readonly string[]): void;
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

export type Source = (page: Page) => Promise<Rendered>;

/** Host effects behind targets and actions the app cannot serve from docs alone. */
export interface Effects {
  /** Visit a location outside the TUI; resolves to a message when it cannot. */
  visitLocation(target: Extract<Target, { kind: "location" }>): Promise<string | undefined>;
  /** Open an external URL; resolves to a message when it cannot. */
  openUrl(url: string): Promise<string | undefined>;
  /** Record `file` of `snapshot`'s change reviewed. */
  mark(snapshot: ChangeSnapshot, file: FilePath, evenThoughNotReviewing: boolean): Promise<MarkReviewedResult>;
  /** The change's current parent; undefined for one with no log. */
  parent(change: ChangeName): Promise<ChangeName | undefined>;
  /** The changes whose current parent is `change`, sorted. */
  children(change: ChangeName): Promise<readonly ChangeName[]>;
}

interface View {
  readonly page: Page;
  doc: Doc;
  snapshot: ChangeSnapshot | undefined;
  /** The page may name state an action moved; it refreshes when it resurfaces. */
  stale: boolean;
  readonly folded: Set<number>;
  cursor: number;
  top: number;
}

/** A yes/no confirmation pending on the status row; `y` proceeds, any other key declines. */
interface Question {
  readonly text: string;
  readonly proceed: () => Promise<void> | void;
}

/** The keys that pick choice entries, in display order. */
const CHOICE_KEYS = "123456789abcdefghijklmnopqrstuvwxyz";

/** A keyed selection pending as an overlay; its key picks, anything else declines. */
interface Choice {
  readonly text: string;
  readonly options: readonly string[];
  readonly proceed: (index: number) => Promise<void> | void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The TUI's state: a stack of open pages — opening pushes, closing pops —
 * with a cursor, folds, and scroll position per page, plus the chord,
 * message, question, or choice the status row and overlay show. Keys arrive
 * through `handleKey`; every mutation ends by painting a fresh frame.
 */
export class App {
  private readonly stack: View[] = [];
  private pending: string[] = [];
  private note: string | undefined;
  private overlay: readonly string[] | undefined;
  private question: Question | undefined;
  private choice: Choice | undefined;
  /** Per displayed diff, the round ends it was shown up to: evidence for mark's viewed check. */
  private readonly displayedEnds = new Map<string, Set<Revision>>();

  constructor(
    private readonly source: Source,
    private readonly terminal: Terminal,
    private readonly effects: Effects,
  ) {}

  /**
   * Open `page` on top of the stack. A failed render reports on the page
   * beneath instead of pushing; with no page beneath the error is the
   * host's to show.
   */
  async open(page: Page): Promise<void> {
    try {
      const { doc, snapshot, viewed } = await this.source(page);
      this.recordViewed(viewed);
      this.stack.push({ page, doc, snapshot, stale: false, folded: new Set(), cursor: 0, top: 0 });
      this.noteErrors(doc);
    } catch (error) {
      if (this.stack.length === 0) {
        throw error;
      }
      this.note = message(error);
    }
    this.repaint();
  }

  /** Feed one named key; resolves to whether the TUI lives on. */
  async handleKey(key: string): Promise<"continue" | "quit"> {
    const current = this.current();
    this.note = undefined;
    if (this.question !== undefined) {
      const question = this.question;
      this.question = undefined;
      if (key === "y" || key === "Y") {
        await question.proceed();
      }
      this.repaint();
      return "continue";
    }
    if (this.choice !== undefined) {
      const choice = this.choice;
      this.choice = undefined;
      const index = CHOICE_KEYS.indexOf(key);
      if (index !== -1 && index < choice.options.length) {
        await choice.proceed(index);
      }
      this.repaint();
      return "continue";
    }
    if (this.overlay !== undefined) {
      this.overlay = undefined;
      this.repaint();
      return "continue";
    }
    if (key === "esc") {
      this.pending = [];
      this.repaint();
      return "continue";
    }
    const attempt = [...this.pending, key];
    const matches = bindingsFor(current.page.kind).filter((binding) => attempt.every((k, i) => binding.keys[i] === k));
    const exact = matches.find((binding) => binding.keys.length === attempt.length);
    if (exact !== undefined) {
      this.pending = [];
      const outcome = await this.run(exact.command);
      if (outcome === "continue") {
        this.repaint();
      }
      return outcome;
    }
    if (matches.length > 0) {
      this.pending = attempt;
    } else {
      this.pending = [];
      this.note = `${attempt.join(" ")} is undefined`;
    }
    this.repaint();
    return "continue";
  }

  /** Repaint the current frame, e.g. after the terminal resizes. */
  repaint(): void {
    const current = this.current();
    const width = this.terminal.columns();
    const height = this.contentHeight();
    // A resize may have left the cursor outside the viewport.
    this.scrollIntoView(current);
    const content = [...paintPage(current, width, height, this.terminal.depth)];
    while (content.length < height) {
      content.push("");
    }
    const overlay = this.overlay ?? this.choiceOverlay();
    if (overlay !== undefined) {
      // A viewport shorter than the overlay keeps its head: the title and
      // the primary entries lead the list.
      const shown = overlay.slice(0, height);
      content.splice(height - shown.length, shown.length, ...shown);
    }
    const right =
      this.question !== undefined
        ? `${this.question.text} y/n`
        : this.pending.length > 0
          ? this.pending.join(" ")
          : (this.note ?? "");
    this.terminal.render([...content, paintStatus(pagePath(current.page), right, width)]);
  }

  private current(): View {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      throw new Error("the page stack is empty");
    }
    return top;
  }

  private contentHeight(): number {
    return Math.max(1, this.terminal.rows() - 1);
  }

  private noteErrors(doc: Doc): void {
    if (doc.errors.length > 0) {
      this.note = doc.errors.join("; ");
    }
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

  private ask(text: string, proceed: Question["proceed"]): void {
    this.question = { text, proceed };
  }

  private choiceOverlay(): readonly string[] | undefined {
    if (this.choice === undefined) {
      return undefined;
    }
    const shown = this.choice.options.slice(0, CHOICE_KEYS.length);
    const rest = this.choice.options.length - shown.length;
    return [
      "",
      ` ${this.choice.text}:`,
      ...shown.map((option, i) => ` ${CHOICE_KEYS[i]}  ${option}`),
      ...(rest > 0 ? [` … and ${rest} more`] : []),
    ];
  }

  private async run(command: Command): Promise<"continue" | "quit"> {
    const view = this.current();
    switch (command) {
      case "back": {
        this.stack.pop();
        if (this.stack.length === 0) {
          return "quit";
        }
        const top = this.current();
        if (top.stale) {
          await this.refresh(top);
        }
        return "continue";
      }
      case "refresh":
        await this.refresh(view);
        return "continue";
      case "open-target": {
        const target = this.cursorTarget(view);
        if (target !== undefined) {
          await this.follow(target);
        }
        return "continue";
      }
      case "review":
        if (view.page.kind === "show") {
          await this.open({ kind: "review", change: view.page.change, as: view.page.as });
        }
        return "continue";
      case "diffs":
        if (view.page.kind === "show" || view.page.kind === "review") {
          await this.open({ kind: "diffs", change: view.page.change, as: view.page.as });
        }
        return "continue";
      case "mark":
        await this.markAtCursor(view);
        return "continue";
      case "show-parent":
        await this.showParent(view);
        return "continue";
      case "show-child":
        await this.showChild(view);
        return "continue";
      case "toggle-fold": {
        const line = visibleLines(view.doc, view.folded)[view.cursor];
        const fold = line === undefined ? undefined : foldAt(view.doc, line);
        if (fold !== undefined) {
          if (!view.folded.delete(fold.start)) {
            view.folded.add(fold.start);
            view.cursor = visibleLines(view.doc, view.folded).indexOf(fold.start);
          }
          this.scrollIntoView(view);
        }
        return "continue";
      }
      case "help":
        this.overlay = this.helpOverlay(view);
        return "continue";
      case "up":
        this.moveCursor(view, -1);
        return "continue";
      case "down":
        this.moveCursor(view, 1);
        return "continue";
      case "half-up":
        this.moveCursor(view, -Math.floor(this.contentHeight() / 2));
        return "continue";
      case "half-down":
        this.moveCursor(view, Math.floor(this.contentHeight() / 2));
        return "continue";
      case "top":
        this.moveCursor(view, Number.MIN_SAFE_INTEGER);
        return "continue";
      case "bottom":
        this.moveCursor(view, Number.MAX_SAFE_INTEGER);
        return "continue";
    }
  }

  private cursorTarget(view: View): Target | undefined {
    const line = visibleLines(view.doc, view.folded)[view.cursor];
    return line === undefined ? undefined : targetAt(view.doc, line);
  }

  /** Open what `target` denotes — the navigation Enter performs. */
  private async follow(target: Target): Promise<void> {
    switch (target.kind) {
      case "change":
        await this.open({ kind: "show", change: target.change, as: target.as });
        break;
      case "review":
        await this.open({ kind: "review", change: target.change, as: target.as });
        break;
      case "file":
        await this.open({ kind: "diff", change: target.change, file: target.file, as: target.as });
        break;
      case "location":
        this.note = await this.effects.visitLocation(target);
        break;
      case "workspace":
        this.note = `workspace at ${target.path}`;
        break;
      case "url":
        this.note = await this.effects.openUrl(target.url);
        break;
      case "action":
        this.note = `${target.action} is not yet available here; run it from the CLI`;
        break;
    }
  }

  /**
   * Mark a file reviewed: the diff page's file, or on the review page the
   * file the cursor's line resolves to. Marking as a borrowed identity, a
   * never-displayed diff, and reviewing that excludes the user each ask
   * first, mirroring the mark command's overrides.
   */
  private markAtCursor(view: View): Promise<void> | void {
    const page = view.page;
    let file: FilePath;
    if (page.kind === "diff") {
      file = page.file;
    } else if (page.kind === "review") {
      const target = this.cursorTarget(view);
      if (target?.kind !== "file") {
        this.note = "no file at the cursor";
        return;
      }
      file = target.file;
    } else {
      return;
    }
    // The entry will carry the borrowed identity's name, so nothing here
    // may happen on muscle memory alone.
    if (page.as !== undefined) {
      this.ask(`Mark ${file} reviewed as ${page.as}?`, () => this.checkDisplayed(view, file));
      return;
    }
    return this.checkDisplayed(view, file);
  }

  private checkDisplayed(view: View, file: FilePath): Promise<void> | void {
    const snapshot = view.snapshot;
    if (snapshot === undefined) {
      this.note = "the page rendered without its review state; refresh first";
      return;
    }
    const pending = pendingRound(snapshot.rounds, file);
    if (
      pending !== undefined &&
      !this.displayedEnds.get(displayedKey(snapshot.change, snapshot.user, snapshot.base, file))?.has(pending.end)
    ) {
      const whom = view.page.as ?? "you";
      this.ask(`The diff of ${file} has not been displayed to ${whom}. Mark anyway?`, () =>
        this.recordMark(view, snapshot, file, false),
      );
      return;
    }
    return this.recordMark(view, snapshot, file, false);
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
        this.ask(
          `${snapshot.change} is reviewing ${error.reviewing}, which does not include ${whom}. Mark anyway?`,
          () => this.recordMark(view, snapshot, file, true),
        );
        return;
      }
      await this.refreshAll();
      this.note = message(error);
      return;
    }
    if (result.kind === "nothing-left") {
      this.note = `nothing left to review in ${file}`;
      return;
    }
    try {
      await result.recorded;
    } catch (error) {
      await this.refreshAll();
      this.note = message(error);
      return;
    }
    // The mark moved state any open page can name; the hidden pages
    // refresh as they resurface.
    for (const other of this.stack) {
      other.stale = true;
    }
    if (view.page.kind === "diff") {
      // The marked page has served its purpose: move on to the round's
      // next file, or back to the review page when the round is done.
      this.stack.pop();
      await this.open(
        result.next === undefined
          ? { kind: "review", change: view.page.change, as: view.page.as }
          : { kind: "diff", change: view.page.change, file: result.next, as: view.page.as },
      );
    } else {
      await this.refresh(view);
    }
  }

  /** Climb to the parent's show page; a trunk parent has a page of its own. */
  private async showParent(view: View): Promise<void> {
    if (view.page.kind !== "show") {
      return;
    }
    const change = view.page.change;
    const parent = await this.effects.parent(change);
    if (parent === undefined) {
      this.note = `${change} has no parent`;
      return;
    }
    await this.open({ kind: "show", change: parent, as: view.page.as });
  }

  /** Descend to a child's show page, choosing one when the change has several. */
  private async showChild(view: View): Promise<void> {
    if (view.page.kind !== "show") {
      return;
    }
    const page = view.page;
    const children = await this.effects.children(page.change);
    const [only] = children;
    if (only === undefined) {
      this.note = `${page.change} has no children`;
      return;
    }
    if (children.length === 1) {
      await this.open({ kind: "show", change: only, as: page.as });
      return;
    }
    this.choice = {
      text: `Child of ${page.change}`,
      options: children,
      proceed: async (index) => {
        const child = children[index];
        if (child !== undefined) {
          await this.open({ kind: "show", change: child, as: page.as });
        }
      },
    };
  }

  private async refresh(view: View): Promise<void> {
    try {
      const { doc, snapshot, viewed } = await this.source(view.page);
      view.doc = doc;
      view.snapshot = snapshot;
      view.stale = false;
      this.recordViewed(viewed);
      this.noteErrors(doc);
    } catch (error) {
      this.note = message(error);
      return;
    }
    const starts = new Set(view.doc.folds.map(({ start }) => start));
    for (const start of view.folded) {
      if (!starts.has(start)) {
        view.folded.delete(start);
      }
    }
    this.moveCursor(view, 0);
  }

  /**
   * An action moved state any open page can name: re-render the visible one
   * and let the hidden ones refresh as they resurface.
   */
  private async refreshAll(): Promise<void> {
    const current = this.current();
    for (const view of this.stack) {
      view.stale = view !== current;
    }
    await this.refresh(current);
  }

  private moveCursor(view: View, delta: number): void {
    const visible = visibleLines(view.doc, view.folded);
    view.cursor = Math.min(Math.max(view.cursor + delta, 0), Math.max(0, visible.length - 1));
    this.scrollIntoView(view);
  }

  private scrollIntoView(view: View): void {
    const height = this.contentHeight();
    if (view.cursor < view.top) {
      view.top = view.cursor;
    } else if (view.cursor >= view.top + height) {
      view.top = view.cursor - height + 1;
    }
  }

  private helpOverlay(view: View): readonly string[] {
    const bindings = bindingsFor(view.page.kind);
    const width = Math.max(...bindings.map(({ keys }) => keys.join(" ").length));
    return [
      "",
      " Keys on this page (any key dismisses)",
      ...bindings.map(({ keys, label }) => ` ${keys.join(" ").padEnd(width)}  ${label}`),
    ];
  }
}

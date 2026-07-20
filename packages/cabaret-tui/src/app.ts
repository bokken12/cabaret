import { type Doc, type Page, pagePath, type Target, targetAt } from "cabaret-views";
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

/** Host effects behind the targets the app cannot follow as pages. */
export interface Effects {
  /** Visit a location outside the TUI; resolves to a message when it cannot. */
  visitLocation(target: Extract<Target, { kind: "location" }>): Promise<string | undefined>;
  /** Open an external URL; resolves to a message when it cannot. */
  openUrl(url: string): Promise<string | undefined>;
}

interface View {
  readonly page: Page;
  doc: Doc;
  readonly folded: Set<number>;
  cursor: number;
  top: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The TUI's state: a stack of open pages — opening pushes, closing pops —
 * with a cursor, folds, and scroll position per page, plus the chord and
 * message the status row shows. Keys arrive through `handleKey`; every
 * mutation ends by painting a fresh frame.
 */
export class App {
  private readonly stack: View[] = [];
  private pending: string[] = [];
  private note: string | undefined;
  private overlay: readonly string[] | undefined;

  constructor(
    private readonly source: (page: Page) => Promise<Doc>,
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
      const doc = await this.source(page);
      this.stack.push({ page, doc, folded: new Set(), cursor: 0, top: 0 });
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
    if (this.overlay !== undefined) {
      // A viewport shorter than the overlay keeps its head: the title and
      // the primary keys lead the list.
      const shown = this.overlay.slice(0, height);
      content.splice(height - shown.length, shown.length, ...shown);
    }
    const right = this.pending.length > 0 ? this.pending.join(" ") : (this.note ?? "");
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

  private async run(command: Command): Promise<"continue" | "quit"> {
    const view = this.current();
    switch (command) {
      case "back":
        this.stack.pop();
        return this.stack.length === 0 ? "quit" : "continue";
      case "refresh":
        await this.refresh(view);
        return "continue";
      case "open-target": {
        const line = visibleLines(view.doc, view.folded)[view.cursor];
        const target = line === undefined ? undefined : targetAt(view.doc, line);
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

  private async refresh(view: View): Promise<void> {
    try {
      view.doc = await this.source(view.page);
      this.noteErrors(view.doc);
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

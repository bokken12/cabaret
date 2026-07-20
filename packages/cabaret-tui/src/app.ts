import {
  type ChangeName,
  DirtyWorkspaceError,
  DivergedParentError,
  type FilePath,
  type LandOverrides,
  NotOwnerError,
  NotReviewingError,
  type RebaseOverrides,
  type Revision,
  type Self,
  UnreviewedParentError,
  UnsatisfiedObligationsError,
  type UserName,
  userName,
} from "cabaret-core";
import {
  type ChangeSnapshot,
  type Doc,
  displayedKey,
  enclosingPage,
  linkRanges,
  type MarkReviewedResult,
  neighborFiles,
  type Page,
  pagePath,
  pendingRound,
  type Target,
  targetAt,
  type ViewedDiffs,
} from "cabaret-views";
import { bindingsFor, type Command } from "./keymap.js";
import type { MouseEvent } from "./keys.js";
import { type ColorDepth, foldAt, gutterWidth, paintPage, paintStatus, visibleLines } from "./paint.js";

/** Where the terminal's own cursor sits after a frame, in zero-based viewport cells. */
export interface CursorCell {
  readonly row: number;
  readonly column: number;
}

/** What the app draws frames on. */
export interface Terminal {
  columns(): number;
  rows(): number;
  readonly depth: ColorDepth;
  /** Display a full frame — content rows then the status row — parking the cursor at `cursor`. */
  render(rows: readonly string[], cursor: CursorCell): void;
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
  /** The current user and their aliases. */
  self(): Promise<Self>;
  /** Rebase the changes, one alone or several as a stack, ancestormost first. */
  rebase(changes: readonly ChangeName[], overrides: RebaseOverrides): Promise<void>;
  /** Land the changes into their parents as configured, with the stack semantics of `rebase`. */
  land(changes: readonly ChangeName[], overrides: LandOverrides): Promise<void>;
  rename(from: ChangeName, to: ChangeName, evenThoughNotOwner: boolean): Promise<void>;
  reparent(change: ChangeName, parent: ChangeName, evenThoughNotOwner: boolean): Promise<void>;
  setOwner(change: ChangeName, owner: string, evenThoughNotOwner: boolean): Promise<void>;
  /** Widen reviewing one notch; resolves to the set it landed on. */
  widenReviewing(change: ChangeName): Promise<string>;
  disableReviewing(change: ChangeName): Promise<void>;
  /** Flip the change's archived state; resolves to whether it is archived now. */
  toggleArchived(change: ChangeName): Promise<boolean>;
  /** Bring the change into a workspace; resolves to a report for the status row. */
  gotoWorkspace(change: ChangeName, evenThoughDirty: boolean): Promise<string>;
  /** Create a workspace for the change; resolves to its path. */
  addWorkspace(change: ChangeName): Promise<string>;
  /** Remove the change's workspace; resolves to the removed path. */
  removeWorkspace(change: ChangeName, evenThoughDirty: boolean): Promise<string>;
  create(name: ChangeName, parent: ChangeName): Promise<void>;
  /** Every change a reparent could target. */
  changes(): Promise<readonly ChangeName[]>;
  /** Parse a change name, throwing the grammar's complaint. */
  parseName(raw: string): ChangeName;
  /** Fetch remote activity; resolves to a report for the status row. */
  fetch(): Promise<string>;
  /** Sync the change with origin and the forge; resolves to a report. */
  sync(change: ChangeName): Promise<string>;
}

interface View {
  readonly page: Page;
  doc: Doc;
  snapshot: ChangeSnapshot | undefined;
  /** The page may name state an action moved; it refreshes when it resurfaces. */
  stale: boolean;
  readonly folded: Set<number>;
  cursor: number;
  /**
   * The column the cursor aims for, in code points of the line's text; a
   * shorter line shows it clamped without losing the aim, as editors keep a
   * goal column across vertical moves.
   */
  column: number;
  /** The selection's other end, a visible-line index; unset selects the cursor alone. */
  anchor: number | undefined;
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

/** A line of text pending on the status row; enter submits, esc abandons. */
interface Input {
  readonly prompt: string;
  buffer: string;
  readonly submit: (raw: string) => Promise<void> | void;
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
  private input: Input | undefined;
  /** A pressed button not yet released: where it landed, and whether it has dragged rows. */
  private press: { row: number; column: number; dragged: boolean } | undefined;
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
      this.stack.push({
        page,
        doc,
        snapshot,
        stale: false,
        folded: new Set(),
        cursor: 0,
        column: 0,
        anchor: undefined,
        top: 0,
      });
      this.noteErrors(doc);
    } catch (error) {
      if (this.stack.length === 0) {
        throw error;
      }
      this.note = message(error);
    }
    this.repaint();
  }

  /** Replace `view` with `page`: the new page renders first, so a failed render keeps the old one. */
  private async replace(view: View, page: Page): Promise<void> {
    const size = this.stack.length;
    await this.open(page);
    if (this.stack.length > size) {
      const index = this.stack.indexOf(view);
      if (index !== -1) {
        this.stack.splice(index, 1);
      }
    }
  }

  /** Feed one named key; resolves to whether the TUI lives on. */
  async handleKey(key: string): Promise<"continue" | "quit"> {
    const current = this.current();
    this.note = undefined;
    this.press = undefined;
    if (this.question !== undefined) {
      const question = this.question;
      this.question = undefined;
      this.overlay = undefined;
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
    if (this.input !== undefined) {
      const input = this.input;
      if (key === "esc") {
        this.input = undefined;
      } else if (key === "enter") {
        this.input = undefined;
        try {
          await input.submit(input.buffer);
        } catch (error) {
          this.note = message(error);
        }
      } else if (key === "backspace") {
        input.buffer = input.buffer.slice(0, -1);
      } else if (key === "space") {
        input.buffer += " ";
      } else if ([...key].length === 1) {
        input.buffer += key;
      }
      this.repaint();
      return "continue";
    }
    if (this.overlay !== undefined) {
      this.overlay = undefined;
      this.repaint();
      return "continue";
    }
    if (key === "esc" && this.pending.length > 0) {
      this.pending = [];
      this.repaint();
      return "continue";
    }
    if (key === "esc" && current.anchor !== undefined) {
      current.anchor = undefined;
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
      // A bare escape with nothing to answer it dissolves without complaint.
      if (key !== "esc" || attempt.length > 1) {
        this.note = `${attempt.join(" ")} is undefined`;
      }
    }
    this.repaint();
    return "continue";
  }

  /**
   * Act on a mouse event: the wheel scrolls; a press moves the cursor to its
   * row; dragging on extends a selection to the rows crossed; a release that
   * never dragged is a click, following a link under it. While a question,
   * choice, or input waits, clicks are not answers, so they are ignored.
   */
  async handleMouse(event: MouseEvent): Promise<void> {
    if (this.question !== undefined || this.choice !== undefined || this.input !== undefined) {
      this.press = undefined;
      return;
    }
    if (this.overlay !== undefined) {
      if (event.kind === "press") {
        this.overlay = undefined;
        this.repaint();
      }
      return;
    }
    const view = this.current();
    if (event.kind === "wheel") {
      this.scroll(view, event.delta * 3);
      this.repaint();
      return;
    }
    const visible = visibleLines(view.doc, view.folded);
    const row = view.top + event.y - 1;
    switch (event.kind) {
      case "press":
        if (event.y > this.contentHeight() || row >= visible.length) {
          return;
        }
        view.cursor = row;
        view.column = Math.max(0, event.x - 1 - gutterWidth(view.doc));
        view.anchor = undefined;
        this.press = { row, column: event.x - 1 - gutterWidth(view.doc), dragged: false };
        this.scrollIntoView(view);
        break;
      case "drag": {
        if (this.press === undefined) {
          return;
        }
        // Dragging at the top edge scrolls the viewport up; the bottom edge
        // already scrolls by overshooting into the status row.
        if (event.y <= 1 && view.top > 0) {
          view.top -= 1;
        }
        // A drag past the content clamps to its edge rather than escaping it.
        const dragged = Math.max(0, Math.min(view.top + event.y - 1, visible.length - 1));
        if (dragged !== this.press.row) {
          this.press.dragged = true;
        }
        // Selection means changes, so only the home page anchors one; a drag
        // elsewhere still spoils the release's click.
        if (view.page.kind !== "home" || !this.press.dragged) {
          break;
        }
        view.anchor = this.press.row;
        view.cursor = dragged;
        this.scrollIntoView(view);
        break;
      }
      case "release": {
        const press = this.press;
        this.press = undefined;
        if (press === undefined || press.dragged) {
          return;
        }
        const line = visible[press.row];
        const link =
          line === undefined
            ? undefined
            : linkRanges(view.doc).find(
                (range) =>
                  range.line === line && range.start <= press.column && press.column < range.start + range.length,
              );
        if (link !== undefined) {
          await this.follow(link.target);
        }
        break;
      }
    }
    this.repaint();
  }

  /** Scroll the viewport by `delta` rows, dragging the cursor along to stay visible. */
  private scroll(view: View, delta: number): void {
    const visible = visibleLines(view.doc, view.folded);
    const height = this.contentHeight();
    view.top = Math.min(Math.max(view.top + delta, 0), Math.max(0, visible.length - height));
    view.cursor = Math.min(Math.max(view.cursor, view.top), view.top + height - 1, visible.length - 1);
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
    // Whatever needs saying takes the whole row; the page path fills the
    // quiet moments.
    const status =
      this.input !== undefined
        ? paintStatus(`${this.input.prompt}: ${this.input.buffer}`, width)
        : this.question !== undefined
          ? paintStatus(`${this.question.text} y/n`, width, "ask")
          : this.pending.length > 0
            ? paintStatus(this.pending.join(" "), width)
            : this.note !== undefined
              ? paintStatus(this.note, width)
              : paintStatus(pagePath(current.page), width);
    // The terminal's own cursor is the cursor: in the minibuffer while one
    // is open, at the page position otherwise.
    const cursor =
      this.input !== undefined
        ? {
            row: height,
            column: Math.min(width - 1, 1 + [...`${this.input.prompt}: ${this.input.buffer}`].length),
          }
        : {
            row: current.cursor - current.top,
            column: Math.min(width - 1, gutterWidth(current.doc) + this.cursorColumn(current)),
          };
    this.terminal.render([...content, status], cursor);
  }

  /** The column the cursor shows at: its aim, clamped to the cursor line's text. */
  private cursorColumn(view: View): number {
    const line = visibleLines(view.doc, view.folded)[view.cursor];
    const text = view.doc.lines[line ?? -1];
    const length = text === undefined ? 0 : text.spans.reduce((sum, span) => sum + [...span.text].length, 0);
    return Math.min(view.column, length);
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
      case "select":
        view.anchor = view.anchor === undefined ? view.cursor : undefined;
        return "continue";
      case "rebase": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          await this.rebaseFlow(changes, { notOwner: false, parentDiverged: false });
        }
        return "continue";
      }
      case "land": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          await this.landFlow(changes, { notOwner: false, unreviewed: false, parentUnreviewed: false });
        }
        return "continue";
      }
      case "rename": {
        const from = this.singleChange(view, "rename");
        if (from !== undefined) {
          this.input = { prompt: `Rename ${from}`, buffer: from, submit: (raw) => this.renameFlow(view, from, raw) };
        }
        return "continue";
      }
      case "reparent": {
        const change = this.singleChange(view, "reparent");
        if (change !== undefined) {
          await this.reparentPick(change);
        }
        return "continue";
      }
      case "set-owner": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          this.input = {
            prompt: `New owner for ${changes.join(", ")}`,
            buffer: "",
            submit: (raw) => {
              if (raw === "") {
                this.note = "owner must be nonempty";
                return;
              }
              const done = new Set<ChangeName>();
              return this.ownedFlow("Set owner", async (override) => {
                for (const change of changes) {
                  if (!done.has(change)) {
                    await this.effects.setOwner(change, raw, override);
                    done.add(change);
                  }
                }
              });
            },
          };
        }
        return "continue";
      }
      case "widen-reviewing": {
        const change = this.singleChange(view, "widen reviewing of");
        if (change !== undefined) {
          await this.widenFlow(change);
        }
        return "continue";
      }
      case "disable-reviewing": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          await this.attempt(async () => {
            for (const change of changes) {
              await this.effects.disableReviewing(change);
            }
            return `${changes.join(", ")} reviewing none`;
          });
        }
        return "continue";
      }
      case "toggle-archived": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          await this.attempt(async () => {
            const archived: ChangeName[] = [];
            const unarchived: ChangeName[] = [];
            for (const change of changes) {
              ((await this.effects.toggleArchived(change)) ? archived : unarchived).push(change);
            }
            return [
              ...(archived.length > 0 ? [`${archived.join(", ")} archived`] : []),
              ...(unarchived.length > 0 ? [`${unarchived.join(", ")} unarchived`] : []),
            ].join("; ");
          });
        }
        return "continue";
      }
      case "goto-workspace": {
        const change = this.singleChange(view, "go to");
        if (change !== undefined) {
          await this.gotoFlow(change, false);
        }
        return "continue";
      }
      case "add-workspace": {
        const change = this.singleChange(view, "add a workspace for");
        if (change !== undefined) {
          await this.attempt(async () => `workspace at ${await this.effects.addWorkspace(change)}`);
        }
        return "continue";
      }
      case "remove-workspace": {
        const change = this.singleChange(view, "remove the workspace of");
        if (change !== undefined) {
          await this.removeWorkspaceFlow(change, false);
        }
        return "continue";
      }
      case "create-child": {
        const parent = this.singleChange(view, "create a child of");
        if (parent !== undefined) {
          this.input = {
            prompt: `Name for a child of ${parent}`,
            buffer: "",
            submit: (raw) => this.createFlow(raw, parent),
          };
        }
        return "continue";
      }
      case "create-parent": {
        const child = this.singleChange(view, "create a parent of");
        if (child !== undefined) {
          await this.createParentPrompt(child);
        }
        return "continue";
      }
      case "fetch":
        this.note = "fetching\u2026";
        this.repaint();
        await this.attempt(() => this.effects.fetch());
        return "continue";
      case "sync": {
        const changes = this.actionChanges(view);
        if (changes.length > 0) {
          await this.syncFlow(changes);
        }
        return "continue";
      }
      case "step-up":
        if (view.page.kind === "diff") {
          await this.stepToFile(view, "prev");
        } else {
          await this.showParent(view);
        }
        return "continue";
      case "step-down":
        if (view.page.kind === "diff") {
          await this.stepToFile(view, "next");
        } else {
          await this.showChild(view);
        }
        return "continue";
      case "step-outside": {
        const outer = enclosingPage(view.page);
        if (outer !== undefined) {
          await this.replace(view, outer);
        }
        return "continue";
      }
      case "act-as":
        await this.actAsPick(view);
        return "continue";
      case "toggle-fold": {
        view.anchor = undefined;
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
      case "left":
        view.column = Math.max(0, this.cursorColumn(view) - 1);
        return "continue";
      case "right":
        view.column = this.cursorColumn(view) + 1;
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
        switch (target.action) {
          case "sync":
            await this.syncFlow([target.change]);
            break;
          case "rebase":
            await this.rebaseFlow([target.change], { notOwner: false, parentDiverged: false });
            break;
          case "reparent":
            await this.reparentPick(target.change);
            break;
          case "widen reviewing":
            await this.widenFlow(target.change);
            break;
          case "land":
            await this.landFlow([target.change], { notOwner: false, unreviewed: false, parentUnreviewed: false });
            break;
        }
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
      await this.replace(
        view,
        result.next === undefined
          ? { kind: "review", change: view.page.change, as: view.page.as }
          : { kind: "diff", change: view.page.change, file: result.next, as: view.page.as },
      );
    } else {
      await this.refresh(view);
    }
  }

  /**
   * The changes an action applies to, ancestormost first: the page's own
   * change on change-scoped pages; on home, the changes named by the lines
   * the selection covers — just the cursor's line without one. Reports when
   * there are none.
   */
  private actionChanges(view: View): readonly ChangeName[] {
    if (view.page.kind !== "home") {
      return [view.page.change];
    }
    const visible = visibleLines(view.doc, view.folded);
    const from = Math.min(view.anchor ?? view.cursor, view.cursor);
    const to = Math.max(view.anchor ?? view.cursor, view.cursor);
    const changes: ChangeName[] = [];
    for (let row = from; row <= to; row++) {
      const line = visible[row];
      const target = line === undefined ? undefined : targetAt(view.doc, line);
      if (target?.kind === "change") {
        changes.push(target.change);
      }
    }
    if (changes.length === 0) {
      this.note = "no change at the cursor";
    }
    return [...new Set(changes)];
  }

  /** The lone selected change, or undefined after reporting `action` takes exactly one. */
  private singleChange(view: View, action: string): ChangeName | undefined {
    const changes = this.actionChanges(view);
    if (changes.length === 0) {
      return undefined;
    }
    const [only] = changes;
    if (changes.length > 1 || only === undefined) {
      this.note = `select a single change to ${action}`;
      return undefined;
    }
    return only;
  }

  /**
   * Run an action to completion: re-render, then report its note — or, when
   * `overridable` recognizes the failure, ask and leave the retry to the
   * answer, mirroring the CLI's --even-though-* flags.
   */
  private async attempt(
    op: () => Promise<string | undefined>,
    overridable?: (error: unknown) => { readonly question: string; readonly retry: () => Promise<void> } | undefined,
  ): Promise<void> {
    let note: string | undefined;
    try {
      note = await op();
    } catch (error) {
      const override = overridable?.(error);
      if (override !== undefined) {
        this.ask(override.question, override.retry);
        return;
      }
      this.current().anchor = undefined;
      await this.refreshAll();
      this.note = message(error);
      return;
    }
    this.current().anchor = undefined;
    await this.refreshAll();
    if (note !== undefined) {
      this.note = note;
    }
  }

  /** Run an owner-guarded action, asking past ownership like --even-though-not-owner. */
  private ownedFlow(verb: string, op: (override: boolean) => Promise<void>, overridden = false): Promise<void> {
    return this.attempt(
      async () => {
        await op(overridden);
        return undefined;
      },
      (error) =>
        error instanceof NotOwnerError && !overridden
          ? {
              question: `${error.change} is owned by ${error.owner}, not you. ${verb} anyway?`,
              retry: () => this.ownedFlow(verb, op, true),
            }
          : undefined,
    );
  }

  /** Rebase, asking past each overridable check it trips; a rerun skips the links that already applied. */
  private rebaseFlow(changes: readonly ChangeName[], overrides: RebaseOverrides): Promise<void> {
    return this.attempt(
      async () => {
        await this.effects.rebase(changes, overrides);
        return undefined;
      },
      (error) => {
        if (error instanceof NotOwnerError && !overrides.notOwner) {
          return {
            question: `${error.change} is owned by ${error.owner}, not you. Rebase anyway?`,
            retry: () => this.rebaseFlow(changes, { ...overrides, notOwner: true }),
          };
        }
        if (error instanceof DivergedParentError && !overrides.parentDiverged) {
          return {
            question: `Local ${error.parent} has diverged from origin's copy. Rebase onto the local reading?`,
            retry: () => this.rebaseFlow(changes, { ...overrides, parentDiverged: true }),
          };
        }
        return undefined;
      },
    );
  }

  /** Land, asking past each overridable check it trips; a rerun skips the links that already landed. */
  private landFlow(changes: readonly ChangeName[], overrides: LandOverrides): Promise<void> {
    return this.attempt(
      async () => {
        await this.effects.land(changes, overrides);
        return `landed ${changes.join(", ")}`;
      },
      (error) => {
        if (error instanceof NotOwnerError && !overrides.notOwner) {
          return {
            question: `${error.change} is owned by ${error.owner}, not you. Land anyway?`,
            retry: () => this.landFlow(changes, { ...overrides, notOwner: true }),
          };
        }
        if (error instanceof UnsatisfiedObligationsError && !overrides.unreviewed) {
          this.overlay = ["", " Remaining review:", ...error.details.map((detail) => ` ${detail}`)];
          return {
            question: "Review obligations are unsatisfied. Land anyway?",
            retry: () => this.landFlow(changes, { ...overrides, unreviewed: true }),
          };
        }
        if (error instanceof UnreviewedParentError && !overrides.parentUnreviewed) {
          this.overlay = ["", " Remaining review:", ...error.details.map((detail) => ` ${detail}`)];
          return {
            question: `Parent ${error.parent} has unsatisfied review obligations. Land anyway?`,
            retry: () => this.landFlow(changes, { ...overrides, parentUnreviewed: true }),
          };
        }
        return undefined;
      },
    );
  }

  private async renameFlow(view: View, from: ChangeName, raw: string): Promise<void> {
    if (raw === from) {
      return;
    }
    let to: ChangeName;
    try {
      to = this.effects.parseName(raw);
    } catch (error) {
      this.note = message(error);
      return;
    }
    await this.ownedFlow("Rename", async (override) => {
      await this.effects.rename(from, to, override);
      // A show page names its change, so the renamed one cannot re-render;
      // replace it with the page under the new name.
      if (view.page.kind === "show" && view.page.change === from) {
        await this.replace(view, { kind: "show", change: to, as: view.page.as });
      }
    });
  }

  /**
   * Pick a new parent for `change` — any other change — then reparent onto
   * it. A set past the choice alphabet asks for the name by minibuffer
   * instead.
   */
  private async reparentPick(change: ChangeName): Promise<void> {
    const candidates = (await this.effects.changes()).filter((candidate) => candidate !== change);
    if (candidates.length === 0) {
      this.note = "no other change to reparent onto";
      return;
    }
    const onto = (parent: ChangeName): Promise<void> =>
      this.ownedFlow("Reparent", (override) => this.effects.reparent(change, parent, override));
    if (candidates.length > CHOICE_KEYS.length) {
      this.input = {
        prompt: `New parent for ${change}`,
        buffer: "",
        submit: (raw) => {
          let parent: ChangeName;
          try {
            parent = this.effects.parseName(raw);
          } catch (error) {
            this.note = message(error);
            return;
          }
          if (!candidates.includes(parent)) {
            this.note = `${parent} is not another change here`;
            return;
          }
          return onto(parent);
        },
      };
      return;
    }
    this.choice = {
      text: `New parent for ${change}`,
      options: candidates,
      proceed: (index) => {
        const parent = candidates[index];
        return parent === undefined ? undefined : onto(parent);
      },
    };
  }

  private widenFlow(change: ChangeName): Promise<void> {
    return this.attempt(async () => `${change} reviewing ${await this.effects.widenReviewing(change)}`);
  }

  /** Bring the change into a workspace, asking before a checkout lands in a dirty one. */
  private gotoFlow(change: ChangeName, overridden: boolean): Promise<void> {
    return this.attempt(
      () => this.effects.gotoWorkspace(change, overridden),
      (error) =>
        error instanceof DirtyWorkspaceError && !overridden
          ? {
              question: "This workspace has uncommitted changes. Check out anyway?",
              retry: () => this.gotoFlow(change, true),
            }
          : undefined,
    );
  }

  /** Remove the change's workspace, asking before uncommitted changes are discarded. */
  private removeWorkspaceFlow(change: ChangeName, overridden: boolean): Promise<void> {
    return this.attempt(
      async () => `removed ${await this.effects.removeWorkspace(change, overridden)}`,
      (error) =>
        error instanceof DirtyWorkspaceError && !overridden
          ? {
              question: `The workspace at ${error.path} has uncommitted changes. Discard and remove?`,
              retry: () => this.removeWorkspaceFlow(change, true),
            }
          : undefined,
    );
  }

  private async createFlow(raw: string, parent: ChangeName): Promise<void> {
    let name: ChangeName;
    try {
      name = this.effects.parseName(raw);
    } catch (error) {
      this.note = message(error);
      return;
    }
    await this.attempt(async () => {
      await this.effects.create(name, parent);
      return `created ${name}`;
    });
  }

  /**
   * Splice a new parent in: it takes the child's parent, and the child hangs
   * from it. Its branch starts at the grandparent's tip, so the child's next
   * rebase lands where a rebase onto the grandparent would have.
   */
  private async createParentPrompt(child: ChangeName): Promise<void> {
    const grandparent = await this.effects.parent(child);
    if (grandparent === undefined) {
      this.note = `${child} has no parent`;
      return;
    }
    this.input = {
      prompt: `Name for a parent of ${child}`,
      buffer: "",
      submit: async (raw) => {
        let name: ChangeName;
        try {
          name = this.effects.parseName(raw);
        } catch (error) {
          this.note = message(error);
          return;
        }
        // TODO: check ownership of `child` before creating the parent, so a
        // declined ownership confirmation does not leave the new change
        // created but never spliced in.
        await this.attempt(async () => {
          await this.effects.create(name, grandparent);
          return undefined;
        });
        await this.ownedFlow("Reparent", (override) => this.effects.reparent(child, name, override));
      },
    };
  }

  private async syncFlow(changes: readonly ChangeName[]): Promise<void> {
    this.note = `syncing ${changes.join(", ")}\u2026`;
    this.repaint();
    await this.attempt(async () => {
      const reports: string[] = [];
      for (const change of changes) {
        try {
          reports.push(await this.effects.sync(change));
        } catch (error) {
          // The syncs that finished still report beside the one that failed.
          throw new Error([...reports, `${change}: ${message(error)}`].join("; "));
        }
      }
      return reports.join("; ");
    });
  }

  /** Step a diff page to the file beside it in its round — how a reviewer walks the round. */
  private async stepToFile(view: View, side: "prev" | "next"): Promise<void> {
    if (view.page.kind !== "diff") {
      return;
    }
    const page = view.page;
    if (view.snapshot === undefined) {
      this.note = "the page rendered without its review state; refresh first";
      return;
    }
    const neighbors = neighborFiles(view.snapshot.rounds, page.file);
    if (neighbors === undefined) {
      this.note = `nothing left to review in ${page.file}`;
      return;
    }
    const file = neighbors[side];
    if (file === undefined) {
      this.note = `${page.file} is the round's ${side === "prev" ? "first" : "last"} file`;
      return;
    }
    await this.replace(view, { kind: "diff", change: page.change, file, as: page.as });
  }

  /**
   * Pick a user and reopen the page as them. The list opens on the current
   * user, so swapping back to oneself is a bare pick; aliases follow, and
   * anyone else can be typed in.
   */
  private async actAsPick(view: View): Promise<void> {
    const self = await this.effects.self();
    const aliases = [...self.aliases].sort();
    const swap = (user: UserName): Promise<void> =>
      this.replace(view, { ...view.page, as: user === self.user ? undefined : user });
    this.choice = {
      text: `Act as (currently ${view.page.as ?? self.user})`,
      options: [`${self.user} (yourself)`, ...aliases, "someone else\u2026"],
      proceed: (index) => {
        if (index === 0) {
          return swap(self.user);
        }
        const alias = aliases[index - 1];
        if (alias !== undefined) {
          return swap(alias);
        }
        this.input = {
          prompt: "User to act as",
          buffer: "",
          submit: (raw) => {
            if (raw === "") {
              this.note = "user must be nonempty";
              return;
            }
            return swap(userName(raw));
          },
        };
        return undefined;
      },
    };
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
    view.anchor = undefined;
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

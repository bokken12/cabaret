import {
  type Backend,
  createChange,
  currentParent,
  type FilePath,
  type Forge,
  type ForgeRequestId,
  importRequest,
  type LogEntry,
  landAsConfigured,
  landChain,
  NotOwnerError,
  parseRefName,
  type RefName,
  readConfig,
  rebaseChain,
  rebaseChange,
  renameChange,
  reparentChange,
  resolveChain,
  type TimestampMs,
  timestampMs,
  transferChange,
  UserError,
  userName,
} from "cabaret-core";
import { GitBackend, openGitHubForge } from "cabaret-node";
import {
  binaryDiff,
  changeSnapshot,
  type DiffPage,
  type Doc,
  diffPage,
  diffTitle,
  docText,
  markReviewed,
  type Page,
  pagePath,
  parsePagePath,
  renderPage,
  type Style,
  type Target,
  targetAt,
} from "cabaret-views";
import * as vscode from "vscode";
import { linkRanges, styledRanges } from "./ranges.js";
import { parseRevPath, type Rev, revPath, type Side } from "./revs.js";

const SCHEME = "cabaret";
/** Documents holding one side of a pending diff, for the native diff editor. */
const REV_SCHEME = "cabaret-rev";

/** Open the backend for the repository containing the first workspace folder. */
async function openBackend(): Promise<GitBackend> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error("cabaret needs an open folder inside a git repository");
  }
  return GitBackend.open(folder.uri.fsPath);
}

/**
 * Open the forge for the first workspace folder's origin, or undefined when
 * none is reachable (no folder, no token, or a non-GitHub origin).
 */
async function openForge(): Promise<Forge | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder === undefined ? undefined : openGitHubForge(folder.uri.fsPath).catch(() => undefined);
}

/**
 * Serves `cabaret:` documents, remembering each page's doc so cursor
 * positions hit-test against exactly what is on screen.
 */
class PageProvider implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider {
  private readonly docs = new Map<string, Doc>();
  /** Pending diffs behind rev documents, keyed by diff page path so a diff editor's two sides agree. */
  private readonly revPages = new Map<string, Promise<DiffPage>>();
  /** Rev URIs with an open document, to re-render on refresh. */
  private readonly revDocs = new Set<string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly rendered = new vscode.EventEmitter<void>();
  /** Fires after a render lands in the cache, so editors repaint their decorations. */
  readonly onDidRender = this.rendered.event;

  /**
   * Advertised links over exactly the spans that carry them. Each opens
   * through the `cabaret.followLink` command, sharing Enter's navigation;
   * jump targets stay Enter-only. A cache miss returns none — `renderedDoc`
   * requests the render, whose text landing re-queries links.
   */
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] | undefined {
    const doc = this.renderedDoc(document.uri);
    return doc === undefined
      ? undefined
      : linkRanges(doc).map(({ line, start, length, target }) => {
          const args = encodeURIComponent(JSON.stringify(target));
          const link = new vscode.DocumentLink(
            new vscode.Range(line, start, line, start + length),
            vscode.Uri.parse(`command:cabaret.followLink?${args}`, true),
          );
          link.tooltip =
            target.kind === "file"
              ? `Open ${target.file}`
              : target.kind === "location"
                ? `Open ${target.file}:${target.line}`
                : `Open ${target.change}`;
          return link;
        });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === REV_SCHEME) {
      const { side, change, file } = parseRevPath(uri.path);
      this.revDocs.add(uri.toString());
      const view = (await this.diffPage(change, file)).round?.view;
      // openDiff only opens rev documents on a two-way view, but review can
      // advance under an open editor; both panes say what moved rather than
      // going silently blank.
      if (view === undefined) {
        return "Nothing left to review.\n";
      }
      if (view.kind === "four") {
        return "The base moved under this review; reopen the diff for its 4-way view.\n";
      }
      return view[side] ?? "";
    }
    // Renders can overlap a close or one another, briefly caching a doc out
    // of step with the buffer; the next render resolves it, so no guard.
    const doc = await renderPage(await openBackend(), parsePagePath(uri.path), openForge, {
      context: vscode.workspace.getConfiguration("cabaret").get<number>("context"),
    });
    this.docs.set(uri.toString(), doc);
    // A render whose text matches the buffer emits no document change, so
    // repainting only on document changes would leave pre-render paint stale.
    this.rendered.fire();
    return docText(doc);
  }

  /** The pending diff behind `change`'s `file`, one reading shared by both of a diff editor's sides. */
  private diffPage(change: RefName, file: FilePath): Promise<DiffPage> {
    const key = pagePath({ kind: "diff", change, file });
    const held = this.revPages.get(key);
    if (held !== undefined) {
      return held;
    }
    const fresh = (async () => {
      const backend = await openBackend();
      return diffPage(backend, await changeSnapshot(backend, change), file);
    })();
    this.revPages.set(key, fresh);
    // A failed read is not review state; drop it so the next ask retries.
    fresh.catch(() => this.revPages.delete(key));
    return fresh;
  }

  doc(uri: vscode.Uri): Doc | undefined {
    return this.docs.get(uri.toString());
  }

  /**
   * The doc behind `uri`'s buffer. An extension-host restart re-syncs open
   * documents without re-rendering them, so a miss means a stale buffer:
   * ask for a fresh render rather than leaving the page dead.
   */
  renderedDoc(uri: vscode.Uri): Doc | undefined {
    const doc = this.doc(uri);
    if (doc === undefined) {
      this.changed.fire(uri);
    }
    return doc;
  }

  refresh(uri: vscode.Uri): void {
    if (uri.scheme === REV_SCHEME) {
      // Both sides re-read one fresh diff, whichever side asked.
      const { change, file } = parseRevPath(uri.path);
      this.revPages.delete(pagePath({ kind: "diff", change, file }));
      for (const side of ["prev", "next"] as const) {
        this.changed.fire(uri.with({ path: revPath({ side, change, file }) }));
      }
      return;
    }
    this.changed.fire(uri);
  }

  /** Re-render every open page and rev: any of them can show a change an action just moved. */
  refreshAll(): void {
    this.revPages.clear();
    for (const key of this.docs.keys()) {
      this.changed.fire(vscode.Uri.parse(key));
    }
    for (const key of this.revDocs) {
      this.changed.fire(vscode.Uri.parse(key));
    }
  }

  forget(uri: vscode.Uri): void {
    if (uri.scheme === REV_SCHEME) {
      this.revDocs.delete(uri.toString());
      const { change, file } = parseRevPath(uri.path);
      const open = (side: Side): boolean =>
        this.revDocs.has(uri.with({ path: revPath({ side, change, file }) }).toString());
      if (!open("prev") && !open("next")) {
        this.revPages.delete(pagePath({ kind: "diff", change, file }));
      }
      return;
    }
    this.docs.delete(uri.toString());
  }
}

function revUri(rev: Rev): vscode.Uri {
  return vscode.Uri.from({ scheme: REV_SCHEME, path: revPath(rev) });
}

/**
 * Open the diff left to review for `file`: the native diff editor when git
 * config cabaret.sideBySide asks for two columns and the pending view is a
 * plain two-way text diff, else the diff page — which alone renders 4-way
 * views, binary notices, and the nothing-left guidance. Errors surface as
 * notifications: unlike opening a page, this path reads the repository
 * before any document exists to display them.
 */
async function openDiff(provider: PageProvider, change: RefName, file: FilePath): Promise<void> {
  try {
    const backend = await openBackend();
    const sideBySide = (await readConfig(backend)).sideBySide;
    if (sideBySide !== undefined) {
      // A reading of its own, never cached: the gate must see the world as it
      // is now, and a fallback must not park a page no rev document ever
      // consumes. The panes take their own shared fresh reading below.
      const page = await diffPage(backend, await changeSnapshot(backend, change), file);
      const view = page.round?.view;
      if (view?.kind === "two" && view.prev !== view.next && !binaryDiff(view.prev, view.next)) {
        const next = revUri({ side: "next", change, file });
        // Fresh on open, as openPage refreshes an already-open page: drop any
        // held reading so the panes re-read, already open or not.
        provider.refresh(next);
        await vscode.commands.executeCommand(
          "vscode.diff",
          revUri({ side: "prev", change, file }),
          next,
          diffTitle(page),
          { preview: false },
        );
        return;
      }
    }
    await openPage(provider, { kind: "diff", change, file });
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  }
}

async function openPage(provider: PageProvider, page: Page): Promise<void> {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: pagePath(page) });
  // Reopening an already-open page serves the buffer as it stands, so ask for
  // a fresh render alongside.
  if (provider.doc(uri) !== undefined) {
    provider.refresh(uri);
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Show the change being worked on — the one the active cabaret page is about,
 * or the one whose branch is checked out — falling back to picking one when
 * neither resolves, as on a detached HEAD or a branch that is not a change.
 */
async function showChange(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined && editor.document.uri.scheme === REV_SCHEME) {
    await openPage(provider, { kind: "show", change: parseRevPath(editor.document.uri.path).change });
    return;
  }
  if (editor !== undefined && editor.document.uri.scheme === SCHEME) {
    const page = parsePagePath(editor.document.uri.path);
    if (page.kind !== "todo") {
      await openPage(provider, { kind: "show", change: page.change });
      return;
    }
  }
  const backend = await openBackend();
  const changes = await backend.listChanges();
  const branch = await backend.currentBranch().catch((error: unknown) => {
    if (error instanceof UserError) {
      return undefined;
    }
    throw error;
  });
  const change =
    branch !== undefined && changes.includes(branch)
      ? branch
      : await vscode.window.showQuickPick(changes, { placeHolder: "Change to show" });
  if (change !== undefined) {
    await openPage(provider, { kind: "show", change: parseRefName(change) });
  }
}

/** Expose the active page's kind as the `cabaret.page` context so keybindings can scope to one page. */
function updatePageContext(editor: vscode.TextEditor | undefined): void {
  const uri = editor?.document.uri;
  // Either side of a native diff editor counts as the diff page it shows.
  const kind = uri?.scheme === SCHEME ? parsePagePath(uri.path).kind : uri?.scheme === REV_SCHEME ? "diff" : undefined;
  vscode.commands.executeCommand("setContext", "cabaret.page", kind);
}

/** The change shown by the active editor, when it is a show page. */
function shownChange(): RefName | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return undefined;
  }
  const page = parsePagePath(editor.document.uri.path);
  return page.kind === "show" ? page.change : undefined;
}

/** Climb from a show page to the parent's show page, or to the todo page when the parent is a trunk. */
async function showParent(provider: PageProvider): Promise<void> {
  const change = shownChange();
  if (change === undefined) {
    return;
  }
  const backend = await openBackend();
  const parent = currentParent(change, await backend.readLog(change));
  const parentIsChange = (await backend.listChanges()).includes(parent);
  await openPage(provider, parentIsChange ? { kind: "show", change: parent } : { kind: "todo" });
}

/** Descend from a show page to a child's show page, picking one when the change has several children. */
async function showChild(provider: PageProvider): Promise<void> {
  const change = shownChange();
  if (change === undefined) {
    return;
  }
  const backend = await openBackend();
  const children: RefName[] = [];
  for (const other of await backend.listChanges()) {
    if (currentParent(other, await backend.readLog(other)) === change) {
      children.push(other);
    }
  }
  if (children.length === 0) {
    vscode.window.showInformationMessage(`cabaret: ${change} has no children`);
    return;
  }
  const child =
    children.length === 1
      ? children[0]
      : await vscode.window.showQuickPick(children.sort(), { placeHolder: `Child of ${change}` });
  if (child !== undefined) {
    await openPage(provider, { kind: "show", change: parseRefName(child) });
  }
}

/** Enter at the cursor: any of the line's targets answers, links and jumps alike. */
async function openTarget(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  if (doc === undefined) {
    return;
  }
  const target = targetAt(doc, editor.selection.active.line);
  if (target === undefined) {
    return;
  }
  await followTarget(provider, target);
}

/** Open what `target` denotes — the navigation Enter and a link click share. */
async function followTarget(provider: PageProvider, target: Target): Promise<void> {
  switch (target.kind) {
    case "change":
      await openPage(provider, { kind: "show", change: target.change });
      break;
    case "file":
      await openDiff(provider, target.change, target.file);
      break;
    case "request":
      // The as-if-imported view; importing is its own action.
      await openPage(provider, { kind: "show", change: target.change });
      break;
    case "location": {
      // Visit the working tree's copy: it is the one worth editing, and while
      // reviewing a checked-out change it is the copy the diff shows. A tree
      // on some other branch can drift from the diff's line numbers.
      const uri = vscode.Uri.joinPath(vscode.Uri.file((await openBackend()).root), target.file);
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const position = new vscode.Position(target.line - 1, 0);
        await vscode.window.showTextDocument(document, {
          preview: false,
          selection: new vscode.Range(position, position),
        });
      } catch {
        vscode.window.showInformationMessage(`cabaret: ${target.file} is not in the working tree`);
      }
      break;
    }
  }
}

/**
 * When the active page shows an unimported request — its heading resolves to
 * one — prompt to import and return true, telling the caller to stop.
 */
function promptImportFirst(provider: PageProvider): boolean {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return false;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  const heading = doc === undefined ? undefined : targetAt(doc, 0);
  if (heading?.kind !== "request") {
    return false;
  }
  vscode.window.showInformationMessage(`cabaret: import ${heading.change} first (Cabaret: Import Pull Request)`);
  return true;
}

/** Enter review of the shown change: open its list of files to review. */
async function review(provider: PageProvider): Promise<void> {
  if (promptImportFirst(provider)) {
    return;
  }
  const change = shownChange();
  if (change !== undefined) {
    await openPage(provider, { kind: "review", change });
  }
}

/**
 * Mark the active diff page's file as reviewed, then move on to the round's
 * next file, or back to the change's review page when the round is done.
 * Errors surface as notifications, and every open page re-renders afterwards.
 */
async function markPageReviewed(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return;
  }
  const uri = editor.document.uri;
  const page =
    uri.scheme === SCHEME ? parsePagePath(uri.path) : uri.scheme === REV_SCHEME ? parseRevPath(uri.path) : undefined;
  if (page === undefined || ("kind" in page && page.kind !== "diff")) {
    return;
  }
  const { change, file } = page;
  try {
    const backend = await openBackend();
    // TODO: mark from the snapshot the page displayed (held with the doc)
    // instead of a fresh one, so a commit racing the keypress cannot widen
    // the marked diff.
    const result = markReviewed(backend, now, await changeSnapshot(backend, change), file);
    if (result.kind === "nothing-left") {
      vscode.window.showInformationMessage(`cabaret: nothing left to review in ${file}`);
      return;
    }
    await result.recorded;
    await closeTabs(uri);
    if (result.next === undefined) {
      await openPage(provider, { kind: "review", change });
    } else {
      await openDiff(provider, change, result.next);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Import request `id` as a change, surfacing failure as a notification; returns the change's name. */
async function runImport(id: ForgeRequestId): Promise<RefName | undefined> {
  try {
    const forge = await openForge();
    if (forge === undefined) {
      vscode.window.showErrorMessage("cabaret: no reachable forge for this repository");
      return undefined;
    }
    return (await importRequest(await openBackend(), now, forge, id)).change;
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
    return undefined;
  }
}

/** Import the pull request at the cursor as a change, as `cabaret gh import` does. */
async function importAtCursor(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  // The cursor's request, or the one the page itself displays: a request's
  // show page opens with a heading that resolves to it.
  const atCursor = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
  const heading = doc === undefined ? undefined : targetAt(doc, 0);
  const target = atCursor?.kind === "request" ? atCursor : heading?.kind === "request" ? heading : undefined;
  if (target === undefined) {
    vscode.window.showInformationMessage("cabaret: no pull request at the cursor");
    return;
  }
  await runImport(target.request);
  provider.refreshAll();
}

const now = (): TimestampMs => timestampMs(Date.now());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `showInputBox` validator accepting exactly the strings `parseRefName` does. */
function invalidRefName(value: string): string | undefined {
  try {
    parseRefName(value);
    return undefined;
  } catch (error) {
    return message(error);
  }
}

/**
 * The changes an action applies to, ancestormost first: the shown change on a
 * show page; on the todo page, the changes named by the lines the selection
 * covers, which is just the cursor's line when nothing is selected.
 */
function selectedChanges(provider: PageProvider, editor: vscode.TextEditor): readonly RefName[] {
  if (editor.document.uri.scheme === REV_SCHEME) {
    return [parseRevPath(editor.document.uri.path).change];
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "show") {
    return [page.change];
  }
  const doc = provider.renderedDoc(editor.document.uri);
  if (doc === undefined) {
    return [];
  }
  const changes: RefName[] = [];
  for (let line = editor.selection.start.line; line <= editor.selection.end.line; line++) {
    const target = targetAt(doc, line);
    if (target?.kind === "change") {
      changes.push(target.change);
    }
  }
  return changes;
}

/**
 * Run `act` on the active cabaret page's selected changes. Errors surface as
 * notifications, and every open page re-renders afterwards even on failure: a
 * chain action can partially apply before it stops.
 */
async function actOnSelection(
  provider: PageProvider,
  act: (backend: Backend, editor: vscode.TextEditor, changes: readonly RefName[]) => Promise<void>,
): Promise<void> {
  if (promptImportFirst(provider)) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || (editor.document.uri.scheme !== SCHEME && editor.document.uri.scheme !== REV_SCHEME)) {
    return;
  }
  const changes = selectedChanges(provider, editor);
  if (changes.length === 0) {
    const doc = provider.renderedDoc(editor.document.uri);
    const target = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
    vscode.window.showInformationMessage(
      target?.kind === "request"
        ? `cabaret: import ${target.change} first (Cabaret: Import Pull Request)`
        : "cabaret: no change at the cursor",
    );
    return;
  }
  try {
    await act(await openBackend(), editor, changes);
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/**
 * Run `op` without the ownership override; when it fails because the current
 * user is not the owner, ask for confirmation — this surface's counterpart to
 * the CLI's --even-though-not-owner flag — and retry with the override.
 * Returns whether `op` ran to completion. One confirmation covers the whole
 * invocation: a retried chain skips the links that already applied.
 */
async function confirmNotOwner(button: string, op: (override: boolean) => Promise<void>): Promise<boolean> {
  try {
    await op(false);
    return true;
  } catch (error) {
    if (!(error instanceof NotOwnerError)) {
      throw error;
    }
    const choice = await vscode.window.showWarningMessage(
      `${error.change} is owned by ${error.owner}, not you.`,
      { modal: true },
      button,
    );
    if (choice === undefined) {
      return false;
    }
    await op(true);
    return true;
  }
}

/**
 * Rebase the selection. One change acts alone and reports a landed change as
 * the error it is; several act as a stack, where skipping landed links is
 * part of the semantics.
 */
async function rebaseSelection(backend: Backend, changes: readonly RefName[]): Promise<void> {
  const only = changes.length === 1 ? changes[0] : undefined;
  await confirmNotOwner("Rebase Anyway", async (override) => {
    if (only !== undefined) {
      await rebaseChange(backend, now, only, await backend.readLog(only), override);
    } else {
      await rebaseChain(backend, now, await resolveChain(backend, changes), override);
    }
  });
}

/** Land the selection, with the same one-versus-stack semantics as `rebaseSelection`. */
async function landSelection(backend: Backend, changes: readonly RefName[]): Promise<void> {
  const config = await readConfig(backend);
  await confirmNotOwner("Land Anyway", async (override) => {
    const landOne = async (change: RefName, entries: readonly LogEntry[]) => {
      await landAsConfigured(backend, now, requireForge, config, change, entries, override);
    };
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only !== undefined) {
      await landOne(only, await backend.readLog(only));
    } else {
      await landChain(backend, await resolveChain(backend, changes), landOne);
    }
  });
}

/** The forge, for an operation that cannot proceed without one. */
async function requireForge(): Promise<Forge> {
  const forge = await openForge();
  if (forge === undefined) {
    throw new UserError("no reachable forge for this repository");
  }
  return forge;
}

/** Close every tab showing `uri`, as a document or as either side of a diff editor. */
async function closeTabs(uri: vscode.Uri): Promise<void> {
  const key = uri.toString();
  const shows = (input: unknown): boolean =>
    input instanceof vscode.TabInputText
      ? input.uri.toString() === key
      : input instanceof vscode.TabInputTextDiff &&
        (input.original.toString() === key || input.modified.toString() === key);
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (shows(tab.input)) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}

/** The lone selected change, or undefined after telling the user `action` takes exactly one. */
function singleChange(changes: readonly RefName[], action: string): RefName | undefined {
  const only = changes.length === 1 ? changes[0] : undefined;
  if (only === undefined) {
    vscode.window.showInformationMessage(`cabaret: select a single change to ${action}`);
  }
  return only;
}

/** Prompt for a name and create a change with `parent` as its parent, returning the new name. */
async function promptCreate(backend: Backend, parent: RefName, prompt: string): Promise<RefName | undefined> {
  const raw = await vscode.window.showInputBox({ prompt, validateInput: invalidRefName });
  if (raw === undefined) {
    return undefined;
  }
  const change = parseRefName(raw);
  await createChange(backend, now, change, parent);
  return change;
}

/**
 * Pick a new parent for `change`: any other change, or a branch some change
 * already hangs from, which is how trunks appear without being changes.
 */
async function pickParent(backend: Backend, change: RefName): Promise<RefName | undefined> {
  const changes = await backend.listChanges();
  const candidates = new Set(changes);
  for (const other of changes) {
    candidates.add(currentParent(other, await backend.readLog(other)));
  }
  candidates.delete(change);
  const picked = await vscode.window.showQuickPick([...candidates].sort(), {
    placeHolder: `New parent for ${change}`,
  });
  return picked === undefined ? undefined : parseRefName(picked);
}

/** Prompt for a new name and rename `from`, following a renamed show page to its new name. */
async function rename(
  provider: PageProvider,
  backend: Backend,
  editor: vscode.TextEditor,
  from: RefName,
): Promise<void> {
  const raw = await vscode.window.showInputBox({
    prompt: `Rename ${from}`,
    value: from,
    validateInput: invalidRefName,
  });
  if (raw === undefined || raw === from) {
    return;
  }
  const to = parseRefName(raw);
  if (!(await confirmNotOwner("Rename Anyway", (override) => renameChange(backend, from, to, override)))) {
    return;
  }
  // A show page's URI names the change, so the old page cannot re-render;
  // forget it before the post-action refresh and replace it with the page
  // under the new name.
  if (editor.document.uri.scheme === SCHEME && parsePagePath(editor.document.uri.path).kind === "show") {
    provider.forget(editor.document.uri);
    await closeTabs(editor.document.uri);
    await openPage(provider, { kind: "show", change: to });
  }
}

/** One editor decoration per `Style`; the mapped type keeps the palette exhaustive. */
type StyleDecorations = { readonly [S in Style]: vscode.TextEditorDecorationType };

/** A diff sign as a gutter icon; mid-gray reads on light and dark themes alike. */
function signIcon(glyph: string): vscode.Uri {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    `<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="13" fill="#888">${glyph}</text></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
}

/**
 * Styles paint as decorations rather than semantic tokens: decorations layer
 * behind the text's own color, so a diff page keeps the reviewed file's
 * syntax highlighting (inferred from the page path's file name) while
 * added/removed wash whole lines like a highlighter pen.
 */
function createDecorations(): StyleDecorations {
  const wash = (background: string, ruler: string, glyph: string): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(background),
      isWholeLine: true,
      gutterIconPath: signIcon(glyph),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor(ruler),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  return {
    heading: vscode.window.createTextEditorDecorationType({ fontWeight: "bold" }),
    // Our own contributed pair rather than the diff editor's: its default
    // green is duller than its red, and a wash this prominent wants balance.
    added: wash("cabaret.addedLineBackground", "editorOverviewRuler.addedForeground", "+"),
    removed: wash("cabaret.removedLineBackground", "editorOverviewRuler.deletedForeground", "-"),
    // A neutral wash on hunk headers, as magit paints its hunk headings.
    hunk: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("cabaret.hunkLineBackground"),
      isWholeLine: true,
    }),
  };
}

/**
 * Repaint every visible cabaret editor's styled ranges. Every style sets its
 * ranges even when empty: a re-render can drop paint an editor still shows.
 * An editor whose doc is not cached is skipped — `renderedDoc` asks for the
 * render, which repaints when it lands.
 */
function paintVisible(provider: PageProvider, decorations: StyleDecorations): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== SCHEME) {
      continue;
    }
    const doc = provider.renderedDoc(editor.document.uri);
    if (doc === undefined) {
      continue;
    }
    const ranges: { readonly [S in Style]: vscode.Range[] } = { heading: [], added: [], removed: [], hunk: [] };
    for (const { line, start, length, style } of styledRanges(doc)) {
      ranges[style].push(new vscode.Range(line, start, line, start + length));
    }
    for (const style of Object.keys(ranges) as readonly Style[]) {
      editor.setDecorations(decorations[style], ranges[style]);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PageProvider();
  const decorations = createDecorations();
  const repaint = (): void => paintVisible(provider, decorations);
  context.subscriptions.push(
    ...Object.values(decorations),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
    vscode.commands.registerCommand("cabaret.followLink", (target: Target) => followTarget(provider, target)),
    // Rendering, the buffer taking a render's new text, and an editor coming
    // on screen each leave paint stale; all three repaint. The first often
    // paints against a buffer still awaiting the render's text — harmless,
    // since the buffer update follows and repaints.
    provider.onDidRender(repaint),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.uri.scheme === SCHEME) {
        repaint();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(repaint),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SCHEME || document.uri.scheme === REV_SCHEME) {
        provider.forget(document.uri);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(updatePageContext),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cabaret.context")) {
        provider.refreshAll();
      }
    }),
    vscode.commands.registerCommand("cabaret.todo", () => openPage(provider, { kind: "todo" })),
    vscode.commands.registerCommand("cabaret.show", () => showChange(provider)),
    vscode.commands.registerCommand("cabaret.openTarget", () => openTarget(provider)),
    vscode.commands.registerCommand("cabaret.showParent", () => showParent(provider)),
    vscode.commands.registerCommand("cabaret.showChild", () => showChild(provider)),
    vscode.commands.registerCommand("cabaret.review", () => review(provider)),
    vscode.commands.registerCommand("cabaret.markReviewed", () => markPageReviewed(provider)),
    vscode.commands.registerCommand("cabaret.import", () => importAtCursor(provider)),
    vscode.commands.registerCommand("cabaret.refresh", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri !== undefined && (uri.scheme === SCHEME || uri.scheme === REV_SCHEME)) {
        provider.refresh(uri);
      }
    }),
    vscode.commands.registerCommand("cabaret.rebase", () =>
      actOnSelection(provider, (backend, _editor, changes) => rebaseSelection(backend, changes)),
    ),
    vscode.commands.registerCommand("cabaret.land", () =>
      actOnSelection(provider, (backend, _editor, changes) => landSelection(backend, changes)),
    ),
    vscode.commands.registerCommand("cabaret.rename", () =>
      actOnSelection(provider, async (backend, editor, changes) => {
        const from = singleChange(changes, "rename");
        if (from !== undefined) {
          await rename(provider, backend, editor, from);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.reparent", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "reparent");
        if (change === undefined) {
          return;
        }
        const parent = await pickParent(backend, change);
        if (parent !== undefined) {
          await confirmNotOwner("Reparent Anyway", (override) =>
            reparentChange(backend, now, change, parent, override),
          );
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.setOwner", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "set the owner of");
        if (change === undefined) {
          return;
        }
        const raw = await vscode.window.showInputBox({
          prompt: `New owner for ${change}`,
          validateInput: (value) => (value === "" ? "owner must be nonempty" : undefined),
        });
        if (raw !== undefined) {
          await confirmNotOwner("Set Owner Anyway", (override) =>
            transferChange(backend, now, change, userName(raw), override),
          );
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.createChild", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const parent = singleChange(changes, "create a child of");
        if (parent !== undefined) {
          await promptCreate(backend, parent, `Name for a child of ${parent}`);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.createParent", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const child = singleChange(changes, "create a parent of");
        if (child === undefined) {
          return;
        }
        // Splice the new change in: it takes the child's parent, and the
        // child hangs from it. Its branch starts at the grandparent's tip, so
        // the child's next rebase lands where a rebase onto the grandparent
        // would have.
        const grandparent = currentParent(child, await backend.readLog(child));
        // TODO: check ownership of `child` before creating the parent, so a
        // declined ownership confirmation does not leave the new change
        // created but never spliced in.
        const parent = await promptCreate(backend, grandparent, `Name for a parent of ${child}`);
        if (parent !== undefined) {
          await confirmNotOwner("Reparent Anyway", (override) => reparentChange(backend, now, child, parent, override));
        }
      }),
    ),
  );
  updatePageContext(vscode.window.activeTextEditor);
  // An extension-host restart re-syncs open cabaret editors without a render;
  // painting them misses the cache and so asks for one.
  repaint();
  // Leaderkey scans `leaderkey.overrides.*` contributions when it activates,
  // which can precede this extension registering its own; a rescan picks the
  // bindings up either way.
  // TODO: reconsider the binding choices — `SPC a f t`/`SPC a f s` were a
  // first guess, not a considered mnemonic.
  if (vscode.extensions.getExtension("JimmyZJX.leaderkey") !== undefined) {
    void vscode.commands.executeCommand("leaderkey.refreshConfigs").then(undefined, () => undefined);
  }
}

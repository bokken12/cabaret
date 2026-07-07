import {
  type Backend,
  changeBase,
  changeTip,
  createChange,
  currentParent,
  type ForgeRequestId,
  importRequest,
  landChain,
  landChange,
  parseRefName,
  type RefName,
  rebaseChain,
  rebaseChange,
  renameChange,
  reparentChange,
  resolveChain,
  reviewRounds,
  type TimestampMs,
  timestampMs,
} from "cabaret-core";
import { GitBackend, GitHubForge } from "cabaret-node";
import { type Doc, docText, targetAt } from "cabaret-views";
import * as vscode from "vscode";
import { type Page, pagePath, parsePagePath } from "./pages.js";
import { renderPage } from "./render.js";
import { styledRanges, TOKEN_TYPES } from "./tokens.js";

const SCHEME = "cabaret";

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
 * none is reachable (no folder, no `gh`, or a non-GitHub origin).
 */
async function openForge(): Promise<GitHubForge | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder === undefined ? undefined : GitHubForge.open(folder.uri.fsPath).catch(() => undefined);
}

/**
 * Serves `cabaret:` documents, remembering each page's doc so cursor
 * positions hit-test against exactly what is on screen.
 */
class PageProvider implements vscode.TextDocumentContentProvider, vscode.DocumentSemanticTokensProvider {
  private readonly docs = new Map<string, Doc>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  readonly legend = new vscode.SemanticTokensLegend([...TOKEN_TYPES]);

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Renders can overlap a close or one another, briefly caching a doc out
    // of step with the buffer; the next render resolves it, so no guard.
    const doc = await renderPage(await openBackend(), parsePagePath(uri.path), openForge);
    this.docs.set(uri.toString(), doc);
    return docText(doc);
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(this.legend);
    for (const { line, start, length, style } of styledRanges(this.renderedDoc(document.uri) ?? { lines: [] })) {
      builder.push(new vscode.Range(line, start, line, start + length), style);
    }
    return builder.build();
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
    this.changed.fire(uri);
  }

  /** Re-render every open page: any of them can name a change an action just moved. */
  refreshAll(): void {
    for (const key of this.docs.keys()) {
      this.changed.fire(vscode.Uri.parse(key));
    }
  }

  forget(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
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

async function showChange(provider: PageProvider): Promise<void> {
  const backend = await openBackend();
  const change = await vscode.window.showQuickPick(await backend.listChanges(), { placeHolder: "Change to show" });
  if (change !== undefined) {
    await openPage(provider, { kind: "show", change: parseRefName(change) });
  }
}

/** Expose the active page's kind as the `cabaret.page` context so keybindings can scope to one page. */
function updatePageContext(editor: vscode.TextEditor | undefined): void {
  const kind = editor?.document.uri.scheme === SCHEME ? parsePagePath(editor.document.uri.path).kind : undefined;
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
  switch (target.kind) {
    case "change":
      await openPage(provider, { kind: "show", change: target.change });
      break;
    case "file":
      await openPage(provider, { kind: "diff", change: target.change, file: target.file });
      break;
    case "request": {
      // Importing materializes the request as a change; land on its show page.
      const change = await runImport(target.request);
      provider.refreshAll();
      if (change !== undefined) {
        await openPage(provider, { kind: "show", change });
      }
      break;
    }
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

/** Enter review of the shown change: open its list of files to review. */
async function review(provider: PageProvider): Promise<void> {
  const change = shownChange();
  if (change !== undefined) {
    await openPage(provider, { kind: "review", change });
  }
}

/**
 * Mark the active diff page's file as reviewed at the end of its earliest
 * pending round, then move on to the round's next file, or back to the
 * change's review page when the round is done. Errors surface as
 * notifications, and every open page re-renders afterwards.
 *
 * TODO: record the round end the open page actually rendered once docs carry
 * their query snapshot; a commit racing the keypress widens the marked diff.
 */
async function markReviewed(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind !== "diff") {
    return;
  }
  try {
    const backend = await openBackend();
    const entries = await backend.readLog(page.change);
    const base = await changeBase(backend, page.change, entries);
    const tip = await changeTip(backend, page.change, entries);
    const user = await backend.currentUser();
    const round = (await reviewRounds(backend, entries, user, base, tip)).find(({ files }) => files.has(page.file));
    if (round === undefined) {
      vscode.window.showInformationMessage(`cabaret: nothing left to review in ${page.file}`);
      return;
    }
    await backend.appendLog(page.change, [
      { timestamp: now(), user, action: { kind: "review", file: page.file, base, tip: round.end } },
    ]);
    await closeTabs(editor.document.uri);
    // The round's next file in list order, wrapping past the end for files
    // skipped earlier. At a round boundary the review page takes over: what
    // to read next changes shape there.
    const remaining = [...round.files.keys()].filter((file) => file !== page.file);
    const next = remaining.find((file) => file > page.file) ?? remaining[0];
    await openPage(
      provider,
      next === undefined ? { kind: "review", change: page.change } : { kind: "diff", change: page.change, file: next },
    );
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
  const target = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
  if (target?.kind !== "request") {
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
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const changes = selectedChanges(provider, editor);
  if (changes.length === 0) {
    vscode.window.showInformationMessage("cabaret: no change at the cursor");
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
 * Rebase or land the selection. One change acts alone and reports a landed
 * change as the error it is; several act as a stack, where skipping landed
 * links is part of the semantics.
 */
async function actOnChain(
  backend: Backend,
  changes: readonly RefName[],
  one: typeof rebaseChange,
  chain: typeof rebaseChain,
): Promise<void> {
  const only = changes.length === 1 ? changes[0] : undefined;
  if (only !== undefined) {
    await one(backend, now, only, await backend.readLog(only), false);
  } else {
    await chain(backend, now, await resolveChain(backend, changes), false);
  }
}

/** Close every tab showing `uri`. */
async function closeTabs(uri: vscode.Uri): Promise<void> {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) {
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
  await renameChange(backend, from, to, false);
  // A show page's URI names the change, so the old page cannot re-render;
  // forget it before the post-action refresh and replace it with the page
  // under the new name.
  if (parsePagePath(editor.document.uri.path).kind === "show") {
    provider.forget(editor.document.uri);
    await closeTabs(editor.document.uri);
    await openPage(provider, { kind: "show", change: to });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    // TODO: move 2-way diff signs out of the text and into the gutter, so
    // selecting lines copies clean content: have diffDoc emit the hunk lines
    // without their `+|`/`-|` marks (the added/removed styles already say
    // which is which) and paint them here with whole-line background
    // decorations plus a gutter sign, applied to every visible editor showing
    // a diff page and reapplied on render. Semantic tokens can only color
    // text, so this takes a per-editor decoration pass alongside them.
    vscode.languages.registerDocumentSemanticTokensProvider({ scheme: SCHEME }, provider, provider.legend),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SCHEME) {
        provider.forget(document.uri);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(updatePageContext),
    vscode.commands.registerCommand("cabaret.todo", () => openPage(provider, { kind: "todo" })),
    vscode.commands.registerCommand("cabaret.show", () => showChange(provider)),
    vscode.commands.registerCommand("cabaret.openTarget", () => openTarget(provider)),
    vscode.commands.registerCommand("cabaret.showParent", () => showParent(provider)),
    vscode.commands.registerCommand("cabaret.showChild", () => showChild(provider)),
    vscode.commands.registerCommand("cabaret.review", () => review(provider)),
    vscode.commands.registerCommand("cabaret.markReviewed", () => markReviewed(provider)),
    vscode.commands.registerCommand("cabaret.import", () => importAtCursor(provider)),
    vscode.commands.registerCommand("cabaret.refresh", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri !== undefined && uri.scheme === SCHEME) {
        provider.refresh(uri);
      }
    }),
    vscode.commands.registerCommand("cabaret.rebase", () =>
      actOnSelection(provider, (backend, _editor, changes) => actOnChain(backend, changes, rebaseChange, rebaseChain)),
    ),
    vscode.commands.registerCommand("cabaret.land", () =>
      actOnSelection(provider, (backend, _editor, changes) => actOnChain(backend, changes, landChange, landChain)),
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
          await reparentChange(backend, now, change, parent, false);
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
        const parent = await promptCreate(backend, grandparent, `Name for a parent of ${child}`);
        if (parent !== undefined) {
          await reparentChange(backend, now, child, parent, false);
        }
      }),
    ),
  );
  updatePageContext(vscode.window.activeTextEditor);
}

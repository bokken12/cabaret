import {
  type Backend,
  createChange,
  currentParent,
  type Forge,
  type ForgeChangeId,
  importChange,
  type LandOverrides,
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
  reviewerSummary,
  syncForgeSnapshot,
  type TimestampMs,
  timestampMs,
  transferChange,
  UnsatisfiedObligationsError,
  UserError,
  userName,
} from "cabaret-core";
import { GitBackend, openGitHubForge } from "cabaret-node";
import {
  changeSnapshot,
  type Doc,
  docText,
  markReviewed,
  type Page,
  pagePath,
  parsePagePath,
  renderPage,
  type Style,
  sectionAt,
  type Target,
  targetAt,
} from "cabaret-views";
import * as vscode from "vscode";
import { linkRanges, styledRanges } from "./ranges.js";

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
  /** Folded sections per page, held across re-renders so a refresh keeps the folds. */
  private readonly folds = new Map<string, Set<string>>();
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
    // Renders can overlap a close or one another, briefly caching a doc out
    // of step with the buffer; the next render resolves it, so no guard.
    const doc = await renderPage(await openBackend(), parsePagePath(uri.path), {
      context: vscode.workspace.getConfiguration("cabaret").get<number>("context"),
      folded: this.folds.get(uri.toString()),
    });
    this.docs.set(uri.toString(), doc);
    // A render whose text matches the buffer emits no document change, so
    // repainting only on document changes would leave pre-render paint stale.
    this.rendered.fire();
    return docText(doc);
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

  /** Fold `section` on `uri`'s page, or unfold it when already folded, and re-render. */
  toggleFold(uri: vscode.Uri, section: string): void {
    const key = uri.toString();
    const folded = this.folds.get(key) ?? new Set<string>();
    this.folds.set(key, folded);
    if (!folded.delete(section)) {
      folded.add(section);
    }
    this.changed.fire(uri);
  }

  forget(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
    this.folds.delete(uri.toString());
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
 * The todo page surveys every change, so it always picks rather than assuming
 * the checked-out branch is the one wanted.
 */
async function showChange(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let onTodo = false;
  if (editor !== undefined && editor.document.uri.scheme === SCHEME) {
    const page = parsePagePath(editor.document.uri.path);
    if (page.kind !== "todo") {
      await openPage(provider, { kind: "show", change: page.change });
      return;
    }
    onTodo = true;
  }
  const backend = await openBackend();
  const changes = await backend.listChanges();
  const branch = onTodo
    ? undefined
    : await backend.currentBranch().catch((error: unknown) => {
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
      await openPage(provider, { kind: "diff", change: target.change, file: target.file });
      break;
    case "forge-change":
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
 * When the active page shows an unimported forge change — its heading
 * resolves to one — prompt to import and return true, telling the caller to
 * stop.
 */
function promptImportFirst(provider: PageProvider): boolean {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return false;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  const heading = doc === undefined ? undefined : targetAt(doc, 0);
  if (heading?.kind !== "forge-change") {
    return false;
  }
  vscode.window.showInformationMessage(`cabaret: import ${heading.change} first (Cabaret: Import Change)`);
  return true;
}

/** Step one page level shallower — diff → review → show → todo — closing the departed page. */
async function stepOut(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "todo") {
    return;
  }
  const out: Page =
    page.kind === "show"
      ? { kind: "todo" }
      : page.kind === "review"
        ? { kind: "show", change: page.change }
        : { kind: "review", change: page.change };
  await closeTabs(editor.document.uri);
  await openPage(provider, out);
}

/**
 * Move a diff page to the round's previous or next file left to review,
 * marking nothing. Seeks by list order and wraps past the ends, as
 * `markReviewed` picks its next file, so it lands right even when the page's
 * own file has already been reviewed out of the round.
 */
async function stepReviewFile(provider: PageProvider, direction: "previous" | "next"): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind !== "diff") {
    return;
  }
  const snapshot = await changeSnapshot(await openBackend(), page.change);
  const files = [...(snapshot.rounds[0]?.files.keys() ?? [])];
  const file =
    direction === "next"
      ? (files.find((other) => other > page.file) ?? files[0])
      : (files.findLast((other) => other < page.file) ?? files.at(-1));
  if (file === undefined) {
    vscode.window.showInformationMessage(`cabaret: nothing left to review in ${page.change}`);
    return;
  }
  if (file === page.file) {
    vscode.window.showInformationMessage(`cabaret: ${page.file} is the only file left to review`);
    return;
  }
  await closeTabs(editor.document.uri);
  await openPage(provider, { kind: "diff", change: page.change, file });
}

/** Fold or unfold the section under the cursor: hunks on a diff, titled sections, todo subtrees. */
function toggleSection(provider: PageProvider): void {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  if (doc === undefined) {
    return;
  }
  const section = sectionAt(doc, editor.selection.active.line);
  if (section !== undefined) {
    provider.toggleFold(editor.document.uri, section);
  }
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
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind !== "diff") {
    return;
  }
  try {
    const backend = await openBackend();
    const result = markReviewed(backend, now, await changeSnapshot(backend, page.change), page.file);
    if (result.kind === "nothing-left") {
      vscode.window.showInformationMessage(`cabaret: nothing left to review in ${page.file}`);
      return;
    }
    await result.recorded;
    await closeTabs(editor.document.uri);
    await openPage(
      provider,
      result.next === undefined
        ? { kind: "review", change: page.change }
        : { kind: "diff", change: page.change, file: result.next },
    );
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Import forge change `id` as a change, surfacing failure as a notification; returns the change's name. */
async function runImport(id: ForgeChangeId): Promise<RefName | undefined> {
  try {
    const forge = await openForge();
    if (forge === undefined) {
      vscode.window.showErrorMessage("cabaret: no reachable forge for this repository");
      return undefined;
    }
    const backend = await openBackend();
    const { change } = await importChange(backend, now, forge, id);
    await syncForgeSnapshot(backend, now, forge);
    return change;
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
    return undefined;
  }
}

/** Refresh the forge snapshot every page renders from, surfacing failure as a notification. */
async function runSyncForge(provider: PageProvider): Promise<void> {
  try {
    const snapshot = await syncForgeSnapshot(await openBackend(), now, await requireForge());
    const open = snapshot.changes.length;
    vscode.window.setStatusBarMessage(
      `cabaret: synced ${snapshot.locator}, ${open} open forge change${open === 1 ? "" : "s"}`,
      5000,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Import the forge change at the cursor, as `cabaret gh import` does. */
async function importAtCursor(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const doc = provider.renderedDoc(editor.document.uri);
  // The cursor's forge change, or the one the page itself displays: an
  // unimported forge change's show page opens with a heading that resolves
  // to it.
  const atCursor = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
  const heading = doc === undefined ? undefined : targetAt(doc, 0);
  const target = atCursor?.kind === "forge-change" ? atCursor : heading?.kind === "forge-change" ? heading : undefined;
  if (target === undefined) {
    vscode.window.showInformationMessage("cabaret: no forge change at the cursor");
    return;
  }
  await runImport(target.id);
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
  if (promptImportFirst(provider)) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const changes = selectedChanges(provider, editor);
  if (changes.length === 0) {
    const doc = provider.renderedDoc(editor.document.uri);
    const target = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
    vscode.window.showInformationMessage(
      target?.kind === "forge-change"
        ? `cabaret: import ${target.change} first (Cabaret: Import Change)`
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

/**
 * Land the selection, with the same one-versus-stack semantics as
 * `rebaseSelection`, confirming each overridable check the land trips.
 * Reruns after a confirmation skip the links that already landed.
 */
async function landSelection(backend: Backend, changes: readonly RefName[]): Promise<void> {
  const config = await readConfig(backend);
  let anyMerged = false;
  const landAll = async (overrides: LandOverrides) => {
    const landOne = async (change: RefName, entries: readonly LogEntry[]) => {
      const merged = await landAsConfigured(backend, now, requireForge, config, change, entries, overrides);
      anyMerged = anyMerged || merged !== undefined;
    };
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only !== undefined) {
      await landOne(only, await backend.readLog(only));
    } else {
      await landChain(backend, await resolveChain(backend, changes), landOne);
    }
  };
  let overrides: LandOverrides = { notOwner: false, unreviewed: false };
  try {
    for (;;) {
      try {
        return await landAll(overrides);
      } catch (error) {
        let options: vscode.MessageOptions;
        let message: string;
        if (error instanceof NotOwnerError && !overrides.notOwner) {
          message = `${error.change} is owned by ${error.owner}, not you.`;
          options = { modal: true };
          overrides = { ...overrides, notOwner: true };
        } else if (error instanceof UnsatisfiedObligationsError && !overrides.unreviewed) {
          message = "Review obligations are unsatisfied.";
          options = { modal: true, detail: ["Remaining review:", ...reviewerSummary(error.unsatisfied)].join("\n") };
          overrides = { ...overrides, unreviewed: true };
        } else {
          throw error;
        }
        const choice = await vscode.window.showWarningMessage(message, options, "Land Anyway");
        if (choice === undefined) {
          return;
        }
      }
    }
  } finally {
    // Whatever merged is no longer open; the mirror must not keep showing
    // it. Best-effort: the land itself already succeeded.
    if (anyMerged) {
      try {
        await syncForgeSnapshot(backend, now, await requireForge());
      } catch {
        // The next sync refreshes the mirror.
      }
    }
  }
}

/** The forge, for an operation that cannot proceed without one. */
async function requireForge(): Promise<Forge> {
  const forge = await openForge();
  if (forge === undefined) {
    throw new UserError("no reachable forge for this repository");
  }
  return forge;
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
  if (!(await confirmNotOwner("Rename Anyway", (override) => renameChange(backend, from, to, override)))) {
    return;
  }
  // A show page's URI names the change, so the old page cannot re-render;
  // forget it before the post-action refresh and replace it with the page
  // under the new name.
  if (parsePagePath(editor.document.uri.path).kind === "show") {
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
    // Changed words within a line: a stronger wash on just those characters,
    // layered over the whole-line wash.
    "added-word": vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("cabaret.addedWordBackground"),
    }),
    "removed-word": vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("cabaret.removedWordBackground"),
    }),
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
    const ranges: { readonly [S in Style]: vscode.Range[] } = {
      heading: [],
      added: [],
      removed: [],
      "added-word": [],
      "removed-word": [],
      hunk: [],
    };
    for (const { line, start, length, style } of styledRanges(doc)) {
      const bucket = ranges[style];
      // added/removed wash whole lines, and a refined line carries several
      // such spans: a second range would stack the translucent wash.
      if ((style === "added" || style === "removed") && bucket.at(-1)?.start.line === line) {
        continue;
      }
      bucket.push(new vscode.Range(line, start, line, start + length));
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
      if (document.uri.scheme === SCHEME) {
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
    vscode.commands.registerCommand("cabaret.stepOut", () => stepOut(provider)),
    vscode.commands.registerCommand("cabaret.toggleSection", () => toggleSection(provider)),
    vscode.commands.registerCommand("cabaret.previousFile", () => stepReviewFile(provider, "previous")),
    vscode.commands.registerCommand("cabaret.nextFile", () => stepReviewFile(provider, "next")),
    vscode.commands.registerCommand("cabaret.review", () => review(provider)),
    vscode.commands.registerCommand("cabaret.markReviewed", () => markPageReviewed(provider)),
    vscode.commands.registerCommand("cabaret.import", () => importAtCursor(provider)),
    vscode.commands.registerCommand("cabaret.syncForge", () => runSyncForge(provider)),
    vscode.commands.registerCommand("cabaret.refresh", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri !== undefined && uri.scheme === SCHEME) {
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

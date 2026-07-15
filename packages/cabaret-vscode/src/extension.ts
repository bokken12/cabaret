import {
  addChangeWorkspace,
  type Backend,
  changeWorkspace,
  createChange,
  currentParent,
  DirtyWorkspaceError,
  type Forge,
  type GotoResult,
  gotoChange,
  type LandOverrides,
  type LogEntry,
  landAsConfigured,
  landChain,
  NotOwnerError,
  NotReviewingError,
  parseRefName,
  pullForge,
  pushChange,
  type RefName,
  readConfig,
  rebaseChain,
  rebaseChange,
  removeChangeWorkspace,
  renameChange,
  reparentChange,
  resolveChain,
  reviewerSummary,
  setReviewing,
  type TimestampMs,
  timestampMs,
  transferChange,
  UnsatisfiedObligationsError,
  UserError,
  userName,
  widenReviewing,
} from "cabaret-core";
import {
  applySetup,
  auditSetup,
  declinedScopes,
  declineSetup,
  GitBackend,
  GitUnavailableError,
  openGitHubForge,
  type SetupAudit,
} from "cabaret-node";
import {
  changeSnapshot,
  type Doc,
  docText,
  type MarkReviewedResult,
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
class PageProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.FoldingRangeProvider
{
  private readonly docs = new Map<string, Doc>();
  /** What each page last reported, so the re-render after every action does not re-toast it. */
  private readonly reported = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly rendered = new vscode.EventEmitter<void>();
  /** Fires after a render lands in the cache, so editors repaint their decorations. */
  readonly onDidRender = this.rendered.event;
  /** A render can reshape the sections, so folding re-queries follow it, as links do. */
  readonly onDidChangeFoldingRanges = this.rendered.event;

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
                : target.kind === "workspace"
                  ? `Open ${target.path}`
                  : `Open ${target.change}`;
          return link;
        });
  }

  /**
   * The doc's sections as folding ranges, letting tab collapse the one at
   * the cursor. A cache miss returns none and requests the render, as with
   * links.
   */
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] | undefined {
    const doc = this.renderedDoc(document.uri);
    return doc?.folds.map(({ start, end }) => new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Renders can overlap a close or one another, briefly caching a doc out
    // of step with the buffer; the next render resolves it, so no guard.
    let doc: Doc;
    try {
      doc = await renderPage(await openBackend(), parsePagePath(uri.path), {
        context: vscode.workspace.getConfiguration("cabaret").get<number>("context"),
      });
    } catch (error) {
      // A rejected render leaves the buffer as it was, with no other sign
      // anything went wrong; the notification is that sign.
      this.reportErrors(uri, [message(error)]);
      throw error;
    }
    this.docs.set(uri.toString(), doc);
    this.reportErrors(uri, doc.errors);
    // A render whose text matches the buffer emits no document change, so
    // repainting only on document changes would leave pre-render paint stale.
    this.rendered.fire();
    return docText(doc);
  }

  private reportErrors(uri: vscode.Uri, errors: readonly string[]): void {
    const key = uri.toString();
    const joined = errors.join("\n");
    if (joined === (this.reported.get(key) ?? "")) {
      return;
    }
    this.reported.set(key, joined);
    for (const error of errors) {
      vscode.window.showErrorMessage(`cabaret: ${error}`);
    }
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
    // A reopened page's problems are news again.
    this.reported.delete(uri.toString());
  }
}

async function openPage(provider: PageProvider, page: Page): Promise<void> {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: pagePath(page) });
  // Reopening an already-open page serves the buffer as it stands, so ask for
  // a fresh render alongside.
  const open = provider.doc(uri) !== undefined;
  if (open) {
    provider.refresh(uri);
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  // A freshly opened page starts its folded sections folded; a page already
  // on screen keeps whatever the user has unfolded.
  if (!open) {
    const lines = provider.doc(uri)?.folds.flatMap(({ start, folded }) => (folded ? [start] : [])) ?? [];
    if (lines.length > 0) {
      await vscode.commands.executeCommand("editor.fold", { selectionLines: lines });
    }
  }
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
    case "location": {
      // Visit the copy in the workspace holding the change — the one the
      // diff shows and the one worth editing — falling back to this working
      // tree, which can drift from the diff's line numbers when it is on
      // some other branch.
      const backend = await openBackend();
      const workspace = await changeWorkspace(backend, target.change);
      const uri = vscode.Uri.joinPath(vscode.Uri.file(workspace?.path ?? backend.root), target.file);
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
    case "workspace":
      await openWorkspaceWindow(target.path);
      break;
  }
}

/** Open the workspace at `path` in its own window; a window already on that folder takes focus instead. */
async function openWorkspaceWindow(path: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), { forceNewWindow: true });
}

/** Enter review of the shown change: open its list of files to review. */
async function review(provider: PageProvider): Promise<void> {
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
    const snapshot = await changeSnapshot(backend, page.change);
    let result: MarkReviewedResult;
    try {
      result = markReviewed(backend, now, snapshot, page.file);
    } catch (error) {
      if (!(error instanceof NotReviewingError)) {
        throw error;
      }
      const choice = await vscode.window.showWarningMessage(
        `${page.change} is reviewing ${error.reviewing}, which does not include you.`,
        { modal: true },
        "Mark Reviewed Anyway",
      );
      if (choice === undefined) {
        return;
      }
      result = markReviewed(backend, now, snapshot, page.file, true);
    }
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

/** Pull from the forge — import open forge changes and their activity — surfacing failure as a notification. */
async function runPull(provider: PageProvider): Promise<void> {
  try {
    const forge = await requireForge();
    const { open } = await pullForge(await openBackend(), now, forge, () => {});
    vscode.window.setStatusBarMessage(
      `cabaret: pulled ${forge.locator}, ${open} open forge change${open === 1 ? "" : "s"}`,
      5000,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Surface a setup failure, attaching the way out when the failure is git itself. */
function showSetupError(error: unknown): void {
  if (error instanceof GitUnavailableError) {
    void vscode.window.showErrorMessage(`cabaret: ${error.message}`, "Open Download Page").then((choice) => {
      if (choice !== undefined) {
        void vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"));
      }
    });
    return;
  }
  vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
}

/** Apply the unset recommendations in `audits`, reporting the outcome. */
async function applyRecommendations(backend: Backend, audits: readonly SetupAudit[]): Promise<void> {
  await applySetup(backend, audits);
  const applied = audits.filter(({ standing }) => standing.kind === "unset").length;
  if (applied > 0) {
    vscode.window.setStatusBarMessage(
      `cabaret: applied ${applied} recommended git setting${applied === 1 ? "" : "s"}`,
      5000,
    );
  }
  const kept = audits.flatMap(({ rec, standing }) =>
    standing.kind === "differs" ? [`${rec.key} = ${standing.current}`] : [],
  );
  if (kept.length > 0) {
    vscode.window.showInformationMessage(`cabaret: kept ${kept.join(", ")}`);
  }
}

/**
 * Offer the recommended git settings still unset, once per scope: a no is
 * recorded where it was given — global config for the person's settings,
 * local for the repository's — and that scope is never offered again.
 */
async function offerSetup(): Promise<void> {
  try {
    const backend = await openBackend();
    const declined = await declinedScopes(backend);
    const pending = (await auditSetup(backend)).filter(
      ({ rec, standing }) => standing.kind === "unset" && !declined.has(rec.scope),
    );
    if (pending.length === 0) {
      return;
    }
    const briefs = pending.map(({ rec }) => rec.brief).join(", ");
    const choice = await vscode.window.showInformationMessage(
      `cabaret recommends git settings: ${briefs}`,
      "Apply",
      "No",
    );
    if (choice === "Apply") {
      await applyRecommendations(backend, pending);
    } else if (choice === "No") {
      await declineSetup(backend, [...new Set(pending.map(({ rec }) => rec.scope))]);
    }
    // Dismissing the notification decides nothing; the offer returns.
  } catch (error) {
    showSetupError(error);
  }
}

/** Apply the recommended git settings on demand, past any recorded no. */
async function runSetup(): Promise<void> {
  try {
    const backend = await openBackend();
    const audits = await auditSetup(backend);
    if (audits.every(({ standing }) => standing.kind === "applied")) {
      vscode.window.showInformationMessage("cabaret: recommended git settings are already applied");
      return;
    }
    await applyRecommendations(backend, audits);
  } catch (error) {
    showSetupError(error);
  }
}

/** Push each selected change to the forge, ancestormost first. */
async function pushSelection(backend: Backend, changes: readonly RefName[]): Promise<void> {
  const forge = await requireForge();
  const pushed: string[] = [];
  for (const change of changes) {
    const { id } = await pushChange(backend, now, forge, change, await backend.readLog(change));
    pushed.push(`${change} to ${forge.locator}#${id}`);
  }
  vscode.window.setStatusBarMessage(
    pushed.length === 1
      ? `cabaret: pushed ${pushed[0]}`
      : `cabaret: pushed ${pushed.length} changes to ${forge.locator}`,
    5000,
  );
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
  const landAll = async (overrides: LandOverrides) => {
    const landOne = async (change: RefName, entries: readonly LogEntry[]) => {
      await landAsConfigured(backend, now, requireForge, config, change, entries, overrides);
    };
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only !== undefined) {
      await landOne(only, await backend.readLog(only));
    } else {
      await landChain(backend, await resolveChain(backend, changes), landOne);
    }
  };
  let overrides: LandOverrides = { notOwner: false, unreviewed: false };
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
}

/**
 * Bring `change` into a workspace: open the one it has, or materialize one
 * per the workspace-style setting — confirming before a checkout lands in a
 * dirty workspace.
 */
async function gotoSelection(backend: Backend, change: RefName): Promise<void> {
  const config = await readConfig(backend);
  let result: GotoResult;
  try {
    result = await gotoChange(backend, config, change, false);
  } catch (error) {
    if (!(error instanceof DirtyWorkspaceError)) {
      throw error;
    }
    const choice = await vscode.window.showWarningMessage(
      "This workspace has uncommitted changes.",
      { modal: true },
      "Check Out Anyway",
    );
    if (choice === undefined) {
      return;
    }
    result = await gotoChange(backend, config, change, true);
  }
  if (result.kind === "checked-out") {
    vscode.window.setStatusBarMessage(`cabaret: checked out ${change}`, 5000);
  } else if (result.path === backend.root) {
    vscode.window.showInformationMessage(`cabaret: ${change} is checked out in this workspace`);
  } else {
    await openWorkspaceWindow(result.path);
  }
}

/** Create a workspace for `change` at the configured spot and open it in its own window. */
async function addWorkspaceSelection(backend: Backend, change: RefName): Promise<void> {
  const path = await addChangeWorkspace(backend, await readConfig(backend), change);
  await openWorkspaceWindow(path);
}

/** Remove `change`'s workspace, confirming before uncommitted changes are discarded. */
async function removeWorkspaceSelection(backend: Backend, change: RefName): Promise<void> {
  let path: string;
  try {
    path = await removeChangeWorkspace(backend, change, false);
  } catch (error) {
    if (!(error instanceof DirtyWorkspaceError)) {
      throw error;
    }
    const choice = await vscode.window.showWarningMessage(
      `The workspace at ${error.path} has uncommitted changes.`,
      { modal: true },
      "Discard and Remove",
    );
    if (choice === undefined) {
      return;
    }
    path = await removeChangeWorkspace(backend, change, true);
  }
  vscode.window.setStatusBarMessage(`cabaret: removed ${path}`, 5000);
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

/** A diff sign as a gutter icon; mid-gray reads on light and dark themes
 *  alike. Two-character signs (a ddiff's outer and inner channel) shrink to
 *  fit the gutter box. */
function signIcon(glyph: string): vscode.Uri {
  const size = glyph.length > 1 ? 9 : 13;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    `<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="${size}" fill="#888">${glyph}</text></svg>`;
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
  // A conflict's ddiff line: the inner sign's wash and ruler mark when it
  // has one, a colored left border saying which diff carries the line, and a
  // two-character gutter sign — outer channel first, inner second. One
  // diff's context lines stay undimmed: they are that diff's own content,
  // not page furniture.
  const ddiff = (inner: "added" | "removed" | undefined, side: "old" | "new", glyph: string) =>
    vscode.window.createTextEditorDecorationType({
      ...(inner === undefined
        ? {}
        : {
            backgroundColor: new vscode.ThemeColor(`cabaret.${inner}LineBackground`),
            overviewRulerColor: new vscode.ThemeColor(
              inner === "added" ? "editorOverviewRuler.addedForeground" : "editorOverviewRuler.deletedForeground",
            ),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
          }),
      isWholeLine: true,
      gutterIconPath: signIcon(glyph),
      gutterIconSize: "contain",
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      borderColor: new vscode.ThemeColor(side === "old" ? "cabaret.oldDiffBorder" : "cabaret.newDiffBorder"),
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
    context: vscode.window.createTextEditorDecorationType({ opacity: "0.6" }),
    // Non-breaking spaces keep the outer sign in its column when the inner
    // position is blank (a context line of just one diff).
    "old-diff-removed": ddiff("removed", "old", "--"),
    "old-diff-added": ddiff("added", "old", "-+"),
    "old-diff-context": ddiff(undefined, "old", "- "),
    "new-diff-removed": ddiff("removed", "new", "+-"),
    "new-diff-added": ddiff("added", "new", "++"),
    "new-diff-context": ddiff(undefined, "new", "+ "),
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
      context: [],
      "old-diff-removed": [],
      "old-diff-added": [],
      "old-diff-context": [],
      "new-diff-removed": [],
      "new-diff-added": [],
      "new-diff-context": [],
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
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, provider),
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
    vscode.commands.registerCommand("cabaret.review", () => review(provider)),
    vscode.commands.registerCommand("cabaret.markReviewed", () => markPageReviewed(provider)),
    vscode.commands.registerCommand("cabaret.pull", () => runPull(provider)),
    vscode.commands.registerCommand("cabaret.setup", () => runSetup()),
    vscode.commands.registerCommand("cabaret.push", () =>
      actOnSelection(provider, (backend, _editor, changes) => pushSelection(backend, changes)),
    ),
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
    vscode.commands.registerCommand("cabaret.widenReviewing", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "widen reviewing of");
        if (change === undefined) {
          return;
        }
        const { to } = await widenReviewing(backend, now, change, await backend.readLog(change));
        vscode.window.showInformationMessage(`cabaret: ${change} reviewing ${to}`);
      }),
    ),
    vscode.commands.registerCommand("cabaret.disableReviewing", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "disable reviewing of");
        if (change === undefined) {
          return;
        }
        await setReviewing(backend, now, change, await backend.readLog(change), "none");
      }),
    ),
    vscode.commands.registerCommand("cabaret.gotoWorkspace", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "go to");
        if (change !== undefined) {
          await gotoSelection(backend, change);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.addWorkspace", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "add a workspace for");
        if (change !== undefined) {
          await addWorkspaceSelection(backend, change);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.removeWorkspace", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "remove the workspace of");
        if (change !== undefined) {
          await removeWorkspaceSelection(backend, change);
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
  // Lazy activation makes this fire on the first real use of cabaret in a
  // repository, which is when its recommendations are worth having.
  void offerSetup();
  // Leaderkey scans `leaderkey.overrides.*` contributions when it activates,
  // which can precede this extension registering its own; a rescan picks the
  // bindings up either way.
  // TODO: reconsider the binding choices — `SPC a f t`/`SPC a f s` were a
  // first guess, not a considered mnemonic.
  if (vscode.extensions.getExtension("JimmyZJX.leaderkey") !== undefined) {
    void vscode.commands.executeCommand("leaderkey.refreshConfigs").then(undefined, () => undefined);
  }
}

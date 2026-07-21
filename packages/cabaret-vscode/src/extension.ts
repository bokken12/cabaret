import {
  addChangeWorkspace,
  applySetup,
  auditSetup,
  type Backend,
  type ChangeName,
  checkoutChange,
  createChange,
  currentArchived,
  currentParent,
  currentSelf,
  DirtyWorkspaceError,
  DivergedParentError,
  declinedScopes,
  declineSetup,
  type FetchEvent,
  type FilePath,
  type Forge,
  fetchForge,
  fetchLocal,
  type GotoOption,
  type GotoResult,
  gotoChange,
  gotoOffer,
  isConnectivityError,
  knownChanges,
  type LandOverrides,
  type LogEntry,
  landAsConfigured,
  landChain,
  NotOwnerError,
  NotReviewingError,
  type RebaseOverrides,
  type Revision,
  readConfig,
  rebaseChain,
  rebaseChange,
  reclaimWorkspaces,
  removeChangeWorkspace,
  renameChange,
  reparentChange,
  resolveChain,
  reviewerSummary,
  type SetupAudit,
  setArchived,
  setReviewing,
  syncChange,
  type TimestampMs,
  timestampMs,
  transferChange,
  UnreviewedParentError,
  UnsatisfiedObligationsError,
  UserError,
  type UserName,
  userName,
  VcsUnavailableError,
  widenReviewing,
} from "cabaret-core";
import { NoForgeError, openBackend as openRepositoryBackend, openForge as openRepositoryForge } from "cabaret-node";
import {
  type ChangeSnapshot,
  changeSnapshot,
  type Doc,
  displayedKey,
  docText,
  enclosingPage,
  linkRanges,
  type MarkReviewedResult,
  markReviewed,
  neighborFiles,
  type Page,
  pagePath,
  parsePagePath,
  reclaimNote,
  renderPage,
  type Style,
  styledRanges,
  type Target,
  targetAt,
} from "cabaret-views";
import * as vscode from "vscode";
import { BackoffLoop } from "./backoff.js";
import { type Manifest, pageHelp } from "./help.js";
import { writePageGrammar } from "./language.js";

const SCHEME = "cabaret";

/**
 * The backend for whichever folder `openBackend` last opened: the root,
 * version-control kind, and object-reading child process it holds are all
 * fixed by the folder's path, so reopening it fresh on every command only
 * costs a repository probe and a few subprocess spawns for nothing.
 */
let cachedBackend: { readonly path: string; readonly backend: Promise<Backend> } | undefined;

/** Open the backend for the repository containing the first workspace folder. */
function openBackend(): Promise<Backend> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error("cabaret needs an open folder inside a repository");
  }
  if (cachedBackend === undefined || cachedBackend.path !== folder.uri.fsPath) {
    const path = folder.uri.fsPath;
    // A failed open (not a repository yet, say) is not cached: the next call
    // gets a fresh attempt rather than the same rejection forever.
    const backend = openRepositoryBackend(path).catch((error: unknown) => {
      if (cachedBackend?.path === path) {
        cachedBackend = undefined;
      }
      throw error;
    });
    cachedBackend = { path, backend };
  }
  return cachedBackend.backend;
}

/** Open the supported forge named by the first workspace folder's origin. */
async function openForge({ signIn = true }: { signIn?: boolean } = {}): Promise<Forge> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new UserError("cabaret needs an open folder inside a repository");
  }
  return openRepositoryForge(folder.uri.fsPath, { github: () => githubSession(signIn) });
}

/**
 * A token from VS Code's built-in GitHub authentication provider. The
 * session lives in the account store, so one sign-in outlasts restarts —
 * rescuing the common case of a GUI-launched VS Code whose environment
 * carries no token. `signIn` gates the sign-in dialog: commands the user
 * just ran may prompt, while the background poll only reuses a session
 * already granted, staying invisible in repositories whose forge the user
 * never asked cabaret to touch.
 */
async function githubSession(signIn: boolean): Promise<string> {
  const session = signIn
    ? await vscode.authentication.getSession("github", ["repo"], { createIfNone: true })
    : await vscode.authentication.getSession("github", ["repo"], { silent: true });
  if (session === undefined) {
    throw new UserError("no GitHub session");
  }
  return session.accessToken;
}

function backgroundSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration("cabaret").get<boolean>("backgroundSync") ?? true;
}

/**
 * The local half of a fetch -- origin refreshed, branches losing nothing
 * advanced, logs settled; nothing from the forge. Every log entry this can
 * produce was put there by somebody's forge sweep already, published through
 * the shared log refs, so running this often costs nothing beyond git's own
 * traffic and still surfaces a teammate's absorbed comment or land quickly,
 * without this workspace polling the forge itself to get it.
 */
async function fetchLocalHalf(): Promise<void> {
  await fetchLocal(await openBackend());
}

/**
 * Keeps branches and cabaret's logs synced with `origin` on a short,
 * git-only cadence -- no forge call, so nothing here costs API budget.
 * Backs off on a connectivity failure and resets the moment a fetch
 * succeeds again; a real failure (not a repository, say) is reported but
 * left on the normal cadence, since backing off would not fix it.
 */
const localSyncLoop = new BackoffLoop({
  run: fetchLocalHalf,
  baseIntervalMs: 10_000,
  maxIntervalMs: 2 * 60_000,
  isTransient: isConnectivityError,
  shouldRun: backgroundSyncEnabled,
  onSettled: (result) => {
    if (!result.ok && !result.backingOff) {
      showBackgroundSyncError(result.error);
    }
  },
});

/** The last background error shown, so a persistent failure nags once rather than every retry. */
let lastShownSyncError: string | undefined;

/** Surface a real (non-connectivity) background sync failure once, quietly -- a status bar message, not a popup, since nothing here was user-triggered. */
function showBackgroundSyncError(error: unknown): void {
  const text = message(error);
  if (text === lastShownSyncError) {
    return;
  }
  lastShownSyncError = text;
  vscode.window.setStatusBarMessage(`cabaret: background sync failed — ${text}`, 8000);
}

/**
 * Serves `cabaret:` documents, remembering each page's doc so cursor
 * positions hit-test against exactly what is on screen.
 */
class PageProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.FoldingRangeProvider
{
  private readonly docs = new Map<string, Doc>();
  /** Per page, the snapshot its doc rendered from: what a mark of the page records. */
  private readonly snapshots = new Map<string, ChangeSnapshot>();
  /** Per displayed diff, the revisions it was shown up to: the evidence `markPageReviewed`'s asked-first check reads. */
  readonly displayedEnds = new Map<string, Set<Revision>>();
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
                  : target.kind === "url"
                    ? `Open ${target.url}`
                    : target.kind === "review"
                      ? `Review ${target.change}${target.as === undefined ? "" : ` as ${target.as}`}`
                      : target.kind === "action"
                        ? `${target.action.charAt(0).toUpperCase()}${target.action.slice(1)} ${target.change}`
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
    let snapshot: ChangeSnapshot | undefined;
    try {
      doc = await renderPage(await openBackend(), parsePagePath(uri.path), {
        context: vscode.workspace.getConfiguration("cabaret").get<number>("context"),
        onSnapshot: (rendered) => {
          snapshot = rendered;
        },
        onViewed: (viewed) => {
          for (const [file, end] of viewed.files) {
            const key = displayedKey(viewed.change, viewed.user, viewed.base, file);
            let ends = this.displayedEnds.get(key);
            if (ends === undefined) {
              ends = new Set();
              this.displayedEnds.set(key, ends);
            }
            ends.add(end);
          }
        },
      });
    } catch (error) {
      // A rejected render leaves the buffer as it was, with no other sign
      // anything went wrong; the notification is that sign.
      this.reportErrors(uri, [message(error)]);
      throw error;
    }
    this.docs.set(uri.toString(), doc);
    if (snapshot !== undefined) {
      this.snapshots.set(uri.toString(), snapshot);
    }
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

  /** The snapshot behind `uri`'s buffer, when its page renders from one. */
  snapshot(uri: vscode.Uri): ChangeSnapshot | undefined {
    return this.snapshots.get(uri.toString());
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
    this.snapshots.delete(uri.toString());
    // A reopened page's problems are news again.
    this.reported.delete(uri.toString());
  }
}

/** The canonical URI addressing `page`: one URI, one open copy of the page. */
function pageUri(page: Page): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: pagePath(page) });
}

async function openPage(provider: PageProvider, page: Page): Promise<void> {
  const uri = pageUri(page);
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
 * neither resolves, as on a detached HEAD or a branch the logs do not speak
 * for. The home page surveys every change, so it always picks rather than
 * assuming the checked-out branch is the one wanted.
 */
async function showChange(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const active =
    editor !== undefined && editor.document.uri.scheme === SCHEME ? parsePagePath(editor.document.uri.path) : undefined;
  if (active !== undefined && active.kind !== "home") {
    await openPage(provider, { kind: "show", change: active.change, as: active.as });
    return;
  }
  const backend = await openBackend();
  const known = await knownChanges(backend);
  const branch =
    active !== undefined
      ? undefined
      : await backend.currentChange().catch((error: unknown) => {
          if (error instanceof UserError) {
            return undefined;
          }
          throw error;
        });
  const change =
    branch !== undefined && known.includes(branch)
      ? branch
      : await vscode.window.showQuickPick([...known], { placeHolder: "Change to show" });
  if (change !== undefined) {
    await openPage(provider, { kind: "show", change: backend.parseName(change), as: active?.as });
  }
}

/** Expose the active page's kind as the `cabaret.page` context so keybindings can scope to one page. */
function updatePageContext(editor: vscode.TextEditor | undefined): void {
  const kind = editor?.document.uri.scheme === SCHEME ? parsePagePath(editor.document.uri.path).kind : undefined;
  vscode.commands.executeCommand("setContext", "cabaret.page", kind);
}

/**
 * Pick a user and reopen the active page as them — the home page when no
 * cabaret page is active. The list opens on the current user, so swapping
 * back to oneself is a bare confirm; one's aliases follow, and anyone else
 * can be typed in.
 */
// TODO: suggest more identities — the change's owner, reviewers, and
// remaining-review users are all cheap from the page at hand; a full
// directory needs an index, not a sweep of every change log.
async function actAs(provider: PageProvider): Promise<void> {
  try {
    const backend = await openBackend();
    const editor = vscode.window.activeTextEditor;
    const active =
      editor !== undefined && editor.document.uri.scheme === SCHEME
        ? parsePagePath(editor.document.uri.path)
        : undefined;
    const page: Page = active ?? { kind: "home" };
    const self = await currentSelf(backend);
    type Item = vscode.QuickPickItem & { readonly user: UserName | undefined };
    const items: Item[] = [
      { label: self.user, description: "yourself", user: self.user },
      ...[...self.aliases].sort().map((alias): Item => ({ label: alias, description: "your alias", user: alias })),
      { label: "someone else…", user: undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Act as (currently ${page.as ?? self.user})`,
    });
    if (picked === undefined) {
      return;
    }
    let user = picked.user;
    if (user === undefined) {
      const raw = await vscode.window.showInputBox({
        prompt: "User to act as",
        validateInput: (value) => (value === "" ? "user must be nonempty" : undefined),
      });
      if (raw === undefined) {
        return;
      }
      user = userName(raw);
    }
    const swapped: Page = { ...page, as: user === self.user ? undefined : user };
    // A swap replaces the page rather than piling identities up in tabs.
    if (editor !== undefined && active !== undefined && pagePath(swapped) !== pagePath(active)) {
      await closeTabs(editor.document.uri);
    }
    await openPage(provider, swapped);
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  }
}

/** The show page the active editor displays, when it is one. */
function shownPage(): Extract<Page, { kind: "show" }> | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return undefined;
  }
  const page = parsePagePath(editor.document.uri.path);
  return page.kind === "show" ? page : undefined;
}

/**
 * Step up to the sibling above: from a show page to the parent's show page
 * — a trunk parent has a page of its own — or from a file's diff to the
 * previous file left.
 */
async function stepUp(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "diff") {
    await stepToFile(provider, editor.document.uri, page, "prev");
    return;
  }
  if (page.kind !== "show") {
    return;
  }
  const backend = await openBackend();
  const entries = await backend.readLog(page.change);
  if (entries.length === 0) {
    vscode.window.showInformationMessage(`cabaret: ${page.change} has no parent`);
    return;
  }
  await openPage(provider, { kind: "show", change: currentParent(page.change, entries), as: page.as });
}

/**
 * Step down to the sibling below: from a show page to a child's show page —
 * picking one when the change has several children — or from a file's diff
 * to the next file left.
 */
async function stepDown(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "diff") {
    await stepToFile(provider, editor.document.uri, page, "next");
    return;
  }
  if (page.kind !== "show") {
    return;
  }
  const backend = await openBackend();
  const children: ChangeName[] = [];
  for (const other of await backend.listChanges()) {
    if (currentParent(other, await backend.readLog(other)) === page.change) {
      children.push(other);
    }
  }
  if (children.length === 0) {
    vscode.window.showInformationMessage(`cabaret: ${page.change} has no children`);
    return;
  }
  const child =
    children.length === 1
      ? children[0]
      : await vscode.window.showQuickPick(children.sort(), { placeHolder: `Child of ${page.change}` });
  if (child !== undefined) {
    await openPage(provider, { kind: "show", change: backend.parseName(child), as: page.as });
  }
}

/**
 * Step a diff page to the file beside it, replacing the page as marking
 * reviewed does — stepping is how a reviewer walks the files left.
 */
async function stepToFile(
  provider: PageProvider,
  uri: vscode.Uri,
  page: Extract<Page, { kind: "diff" }>,
  side: "prev" | "next",
): Promise<void> {
  const backend = await openBackend();
  const neighbors = neighborFiles((await changeSnapshot(backend, page.change, page.as)).left, page.file);
  if (neighbors === undefined) {
    vscode.window.showInformationMessage(`cabaret: nothing left to review in ${page.file}`);
    return;
  }
  const file = neighbors[side];
  if (file === undefined) {
    vscode.window.showInformationMessage(
      `cabaret: ${page.file} is the ${side === "prev" ? "first" : "last"} file left`,
    );
    return;
  }
  await closeTabs(uri);
  await openPage(provider, { kind: "diff", change: page.change, file, as: page.as });
}

/** Escape: back out to the enclosing page, closing the page left behind. */
async function stepOutside(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const outer = enclosingPage(parsePagePath(editor.document.uri.path));
  if (outer === undefined) {
    return;
  }
  await closeTabs(editor.document.uri);
  await openPage(provider, outer);
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
      await openPage(provider, { kind: "show", change: target.change, as: target.as });
      break;
    case "review":
      await openPage(provider, { kind: "review", change: target.change, as: target.as });
      break;
    case "file":
      await openPage(provider, { kind: "diff", change: target.change, file: target.file, as: target.as });
      break;
    case "location":
      await visitLocation(provider, target);
      break;
    case "workspace":
      await openWorkspaceWindow(target.path);
      break;
    case "url":
      await vscode.env.openExternal(vscode.Uri.parse(target.url));
      break;
    case "action":
      await performAction(provider, target);
      break;
  }
}

/**
 * Run the action a target names on its change, sharing the corresponding
 * commands' confirmations; errors and re-renders behave as
 * `actOnSelection`'s do.
 */
async function performAction(provider: PageProvider, target: Extract<Target, { kind: "action" }>): Promise<void> {
  const { change, action } = target;
  try {
    const backend = await openBackend();
    switch (action) {
      case "sync":
        await syncSelection(backend, [change]);
        break;
      case "rebase":
        await rebaseSelection(backend, [change]);
        break;
      case "reparent":
        await reparentSelection(backend, change);
        break;
      case "widen reviewing":
        await widenSelection(backend, change);
        break;
      case "land":
        await landSelection(backend, [change]);
        break;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Open the workspace at `path` in its own window; a window already on that folder takes focus instead. */
async function openWorkspaceWindow(path: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), { forceNewWindow: true });
}

/** Show `file` at 1-based `line` from the workspace at `root`. */
async function openFileAt(root: string, file: string, line: number): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), file);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(line - 1, 0);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(position, position),
    });
  } catch {
    vscode.window.showInformationMessage(`cabaret: ${file} is not in the working tree`);
  }
}

/**
 * Visit `target`'s file for its change. The copy worth seeing is the one in
 * the change's workspace, so when this workspace is not it, offer to bring
 * the change in front of the user first — its own workspace's window, a
 * checkout here, or a fresh workspace — rather than showing a copy whose
 * lines can drift from the diff's.
 */
async function visitLocation(provider: PageProvider, target: Extract<Target, { kind: "location" }>): Promise<void> {
  const backend = await openBackend();
  const offer = await gotoOffer(backend, await readConfig(backend), target.change);
  if (offer.kind === "here") {
    await openFileAt(backend.root, target.file, target.line);
    return;
  }
  const labels: { readonly [K in GotoOption["kind"]]: string } = {
    open: "Open Its Workspace",
    checkout: "Check Out Here",
    add: "Create Its Workspace",
  };
  const picked = await vscode.window.showInformationMessage(
    `${target.change} is not checked out in this workspace.`,
    { modal: true },
    ...offer.options.map((option) => labels[option.kind]),
  );
  const option = offer.options.find((candidate) => labels[candidate.kind] === picked);
  if (option === undefined) {
    return;
  }
  try {
    switch (option.kind) {
      case "open":
        await openWorkspaceWindow(option.path);
        break;
      case "checkout":
        await checkoutChange(backend, target.change, false);
        await openFileAt(backend.root, target.file, target.line);
        break;
      case "add":
        await addChangeWorkspace(backend, target.change, option.path);
        await openWorkspaceWindow(option.path);
        break;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    // A checkout or new workspace reshapes what pages say about workspaces.
    if (option.kind !== "open") {
      provider.refreshAll();
    }
  }
}

/** List the active page's keybindings, read from the manifest; picking one runs it. */
async function showHelp(manifest: Manifest): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path).kind;
  const picked = await vscode.window.showQuickPick(
    pageHelp(manifest, page).map(({ keys, label, command }) => ({ label: keys, description: label, command })),
    { placeHolder: `Keybindings on the ${page} page`, matchOnDescription: true },
  );
  if (picked !== undefined) {
    await vscode.commands.executeCommand(picked.command);
  }
}

/** Enter review of the shown change: open its list of files to review. */
async function review(provider: PageProvider): Promise<void> {
  const page = shownPage();
  if (page !== undefined) {
    await openPage(provider, { kind: "review", change: page.change, as: page.as });
  }
}

/** Open every diff of the active page's change in one buffer. */
async function reviewDiffs(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "home") {
    return;
  }
  await openPage(provider, { kind: "diffs", change: page.change, as: page.as });
}

/**
 * Mark a file reviewed: the active diff page's file, or on the review page
 * the file the cursor's line resolves to. The mark records the page's own
 * snapshot — a change that moved on since the render just leaves the rest
 * pending — so only a mark whose diff this window never displayed asks
 * first. From a diff page, move on to the next file left; marking the last
 * file steps back out to the change's own page. Errors surface as
 * notifications, and every open page re-renders afterwards.
 */
async function markPageReviewed(provider: PageProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return;
  }
  const page = parsePagePath(editor.document.uri.path);
  let file: FilePath;
  if (page.kind === "diff") {
    file = page.file;
  } else if (page.kind === "review") {
    const doc = provider.renderedDoc(editor.document.uri);
    const target = doc === undefined ? undefined : targetAt(doc, editor.selection.active.line);
    if (target?.kind !== "file") {
      vscode.window.showInformationMessage("cabaret: no file at the cursor");
      return;
    }
    file = target.file;
  } else {
    return;
  }
  // The entry will carry the borrowed identity's name, so nothing here may
  // happen on muscle memory alone.
  if (page.as !== undefined) {
    const choice = await vscode.window.showWarningMessage(
      `Mark ${file} reviewed as ${page.as}?`,
      { modal: true },
      "Mark Reviewed",
    );
    if (choice === undefined) {
      return;
    }
  }
  try {
    const backend = await openBackend();
    // An extension-host restart re-syncs the buffer without a render, so a
    // page can lack its snapshot; the fresh one then read falls under the
    // never-displayed ask below.
    const snapshot = provider.snapshot(editor.document.uri) ?? (await changeSnapshot(backend, page.change, page.as));
    if (
      snapshot.left.has(file) &&
      !provider.displayedEnds.get(displayedKey(snapshot.change, snapshot.user, snapshot.base, file))?.has(snapshot.tip)
    ) {
      const choice = await vscode.window.showWarningMessage(
        `The diff of ${file} has not been displayed to ${page.as === undefined ? "you" : page.as}.`,
        { modal: true },
        "Mark Reviewed Anyway",
      );
      if (choice === undefined) {
        return;
      }
    }
    let result: MarkReviewedResult;
    try {
      result = markReviewed(backend, now, snapshot, file);
    } catch (error) {
      if (!(error instanceof NotReviewingError)) {
        throw error;
      }
      const choice = await vscode.window.showWarningMessage(
        `${page.change} is reviewing ${error.reviewing}, which does not include ${
          page.as === undefined ? "you" : error.user
        }.`,
        { modal: true },
        "Mark Reviewed Anyway",
      );
      if (choice === undefined) {
        return;
      }
      result = markReviewed(backend, now, snapshot, file, true);
    }
    if (result.kind === "nothing-left") {
      vscode.window.showInformationMessage(`cabaret: nothing left to review in ${file}`);
      return;
    }
    await result.recorded;
    if (result.next === undefined) {
      // Review is done: fold its pages away — the one being marked and the
      // review page a file-by-file pass leaves open — and land back on the
      // change, whose canonical URI focuses the tab the pass started from.
      await closeTabs(editor.document.uri);
      await closeTabs(pageUri({ kind: "review", change: page.change, as: page.as }));
      await openPage(provider, { kind: "show", change: page.change, as: page.as });
    } else if (page.kind === "diff") {
      await closeTabs(editor.document.uri);
      await openPage(provider, { kind: "diff", change: page.change, file: result.next, as: page.as });
    }
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** What `event` did, in a few words fit for a progress message; undefined for one with nothing change-specific to say. */
function describeFetchEvent(event: FetchEvent): string | undefined {
  switch (event.kind) {
    case "aliased":
      return undefined;
    case "advanced":
      return `advanced ${event.change}`;
    case "imported":
      return `imported ${event.change}`;
    case "skipped":
      return `skipped ${event.change}`;
    case "absorbed":
      return `absorbed ${event.change}`;
    case "archived":
      return `archived ${event.change}`;
    case "pruned":
      return `pruned ${event.change}`;
  }
}

/** Watching {@link pollForge}'s progress live, for whoever's `withProgress` call triggered or joined the run in flight. */
const fetchListeners = new Set<(event: FetchEvent) => void>();

/**
 * Import open forge changes and refresh tracked ones -- the only part of
 * background sync that calls the forge, so the only part worth costing API
 * budget over. Undefined, not a failure, when there is no supported forge
 * here: most repositories this extension opens will never configure one.
 */
async function pollForge(): Promise<{ readonly swept: number } | undefined> {
  let forge: Forge;
  try {
    forge = await openForge({ signIn: false });
  } catch {
    return undefined;
  }
  return fetchForge(await openBackend(), now, forge, (event) => {
    for (const listener of fetchListeners) {
      listener(event);
    }
  });
}

/**
 * Polls the forge on a minutes-scale cadence -- long enough that even many
 * repos doing this stays a small fraction of GitHub's hourly rate limit.
 * Backs off on connectivity failure up to half an hour; a real failure is
 * reported once, not every retry, and left on the normal cadence. Gated by
 * `cabaret.backgroundSync` for its own scheduled ticks only: the manual Pull
 * command always actually pulls, via `runNow`.
 */
function createForgePollLoop(provider: PageProvider): BackoffLoop<{ readonly swept: number } | undefined> {
  return new BackoffLoop({
    run: pollForge,
    baseIntervalMs: 90_000,
    maxIntervalMs: 30 * 60_000,
    isTransient: isConnectivityError,
    shouldRun: backgroundSyncEnabled,
    onSettled: (result) => {
      if (result.ok) {
        provider.refreshAll();
      } else if (!result.backingOff) {
        showBackgroundSyncError(result.error);
      }
    },
  });
}

async function runFetch(provider: PageProvider, forgePollLoop: BackoffLoop<{ readonly swept: number } | undefined>) {
  try {
    const forge = await openForge();
    // A notification appears the moment the command fires, rather than
    // leaving the user staring at an unchanged window until the fetch —
    // several git and forge round trips — finally resolves; its message
    // updates with each change as the fetch works through them, so the wait
    // reads as progress rather than a stalled spinner. `runNow` joins a
    // background poll already in flight rather than starting a second one;
    // listening while it is outstanding still gets this call live events
    // from it, whichever call actually triggered it.
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `cabaret: fetching from ${forge.locator}` },
      async (progress) => {
        const listener = (event: FetchEvent): void => {
          const text = describeFetchEvent(event);
          if (text !== undefined) {
            progress.report({ message: text });
          }
        };
        fetchListeners.add(listener);
        try {
          return await forgePollLoop.runNow();
        } finally {
          fetchListeners.delete(listener);
        }
      },
    );
    const swept = result?.swept ?? 0;
    vscode.window.setStatusBarMessage(
      `cabaret: fetched ${forge.locator}, ${swept} forge change${swept === 1 ? "" : "s"}`,
      5000,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Surface a setup failure, attaching the way out when the failure is the version-control tool itself. */
function showSetupError(error: unknown): void {
  if (error instanceof VcsUnavailableError) {
    const { downloadUrl } = error;
    void vscode.window.showErrorMessage(`cabaret: ${error.message}`, "Open Download Page").then((choice) => {
      if (choice !== undefined) {
        void vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
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
      `cabaret: applied ${applied} recommended setting${applied === 1 ? "" : "s"}`,
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
 * Offer the backend's recommended settings still unset, once per scope: a no
 * is recorded where it was given — global config for the person's settings,
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
    const choice = await vscode.window.showInformationMessage(`cab recommends settings: ${briefs}`, "Apply", "No");
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

/** Apply the backend's recommended settings on demand, past any recorded no. */
async function runSetup(): Promise<void> {
  try {
    const backend = await openBackend();
    const audits = await auditSetup(backend);
    if (audits.every(({ standing }) => standing.kind === "applied")) {
      vscode.window.showInformationMessage("cabaret: recommended settings are already applied");
      return;
    }
    await applyRecommendations(backend, audits);
  } catch (error) {
    showSetupError(error);
  }
}

/** Sync each selected change with origin and the forge, ancestormost first. */
async function syncSelection(backend: Backend, changes: readonly ChangeName[]): Promise<void> {
  let forge: Forge | undefined;
  try {
    forge = await openForge();
  } catch (error) {
    if (!(error instanceof NoForgeError)) {
      throw error;
    }
  }
  const synced: string[] = [];
  let offline = false;
  for (const change of changes) {
    const result = await syncChange(backend, now, forge, change);
    offline ||= result.offline;
    const conflicts = result.joined?.conflicts ?? [];
    if (conflicts.length > 0) {
      vscode.window.showWarningMessage(
        `cabaret: merged origin's copy of ${change} with conflicts in ${conflicts.join(", ")}; fix the markers and amend`,
      );
    }
    synced.push(result.published === undefined ? `${change}` : `${change} to ${forge?.locator}#${result.published.id}`);
  }
  vscode.window.setStatusBarMessage(
    offline
      ? "cabaret: origin unreachable; synced locally — sync again online to publish"
      : synced.length === 1
        ? `cabaret: synced ${synced[0]}`
        : `cabaret: synced ${synced.length} changes`,
    8000,
  );
}

const now = (): TimestampMs => timestampMs(Date.now());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `showInputBox` validator accepting exactly the strings the backend's name grammar does. */
function invalidName(backend: Backend): (value: string) => string | undefined {
  return (value) => {
    try {
      backend.parseName(value);
      return undefined;
    } catch (error) {
      return message(error);
    }
  };
}

/**
 * The changes an action applies to, ancestormost first: the shown change on a
 * show page; on the home page, the changes named by the lines the selection
 * covers, which is just the cursor's line when nothing is selected.
 */
function selectedChanges(provider: PageProvider, editor: vscode.TextEditor): readonly ChangeName[] {
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "show") {
    return [page.change];
  }
  const doc = provider.renderedDoc(editor.document.uri);
  if (doc === undefined) {
    return [];
  }
  const changes: ChangeName[] = [];
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
  act: (backend: Backend, editor: vscode.TextEditor, changes: readonly ChangeName[]) => Promise<void>,
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
 * Rebase the selection, confirming each overridable check it trips. One
 * change acts alone and reports a landed change as the error it is; several
 * act as a stack, where skipping landed links is part of the semantics.
 */
async function rebaseSelection(backend: Backend, changes: readonly ChangeName[]): Promise<void> {
  const only = changes.length === 1 ? changes[0] : undefined;
  const rebaseAll = async (overrides: RebaseOverrides) => {
    if (only !== undefined) {
      await rebaseChange(backend, now, only, await backend.readLog(only), overrides);
    } else {
      await rebaseChain(backend, now, await resolveChain(backend, changes), overrides);
    }
  };
  let overrides: RebaseOverrides = { notOwner: false, parentDiverged: false };
  for (;;) {
    try {
      return await rebaseAll(overrides);
    } catch (error) {
      let message: string;
      if (error instanceof NotOwnerError && !overrides.notOwner) {
        message = `${error.change} is owned by ${error.owner}, not you.`;
        overrides = { ...overrides, notOwner: true };
      } else if (error instanceof DivergedParentError && !overrides.parentDiverged) {
        message = `Local ${error.parent} has diverged from origin's copy; rebase onto the local reading?`;
        overrides = { ...overrides, parentDiverged: true };
      } else {
        throw error;
      }
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Rebase Anyway");
      if (choice === undefined) {
        return;
      }
    }
  }
}

/**
 * Land the selection, with the same one-versus-stack semantics as
 * `rebaseSelection`, confirming each overridable check the land trips.
 * Reruns after a confirmation skip the links that already landed.
 */
async function landSelection(backend: Backend, changes: readonly ChangeName[]): Promise<void> {
  const config = await readConfig(backend);
  const landAll = async (overrides: LandOverrides) => {
    const landOne = async (change: ChangeName, entries: readonly LogEntry[]) => {
      await landAsConfigured(backend, now, openForge, config, change, entries, overrides);
    };
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only !== undefined) {
      await landOne(only, await backend.readLog(only));
    } else {
      await landChain(backend, await resolveChain(backend, changes), landOne);
    }
  };
  let overrides: LandOverrides = { notOwner: false, unreviewed: false, parentUnreviewed: false };
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
      } else if (error instanceof UnreviewedParentError && !overrides.parentUnreviewed) {
        message = `Parent ${error.parent} has unsatisfied review obligations.`;
        options = { modal: true, detail: ["Remaining review:", ...reviewerSummary(error.unsatisfied)].join("\n") };
        overrides = { ...overrides, parentUnreviewed: true };
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

/** Reparent `change` onto a picked parent, confirming an ownership override. */
async function reparentSelection(backend: Backend, change: ChangeName): Promise<void> {
  const parent = await pickParent(backend, change);
  if (parent !== undefined) {
    await confirmNotOwner("Reparent Anyway", (override) => reparentChange(backend, now, change, parent, override));
  }
}

/** Widen reviewing of `change` one notch and report where it landed. */
async function widenSelection(backend: Backend, change: ChangeName): Promise<void> {
  const { to } = await widenReviewing(backend, now, change, await backend.readLog(change));
  vscode.window.showInformationMessage(`cabaret: ${change} reviewing ${to}`);
}

/**
 * Bring `change` into a workspace: open the one it has, or materialize one
 * per the workspace-style setting — confirming before a checkout lands in a
 * dirty workspace.
 */
async function gotoSelection(backend: Backend, change: ChangeName): Promise<void> {
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

/** Create a workspace for `change` and open it in its own window. */
async function addWorkspaceSelection(backend: Backend, change: ChangeName): Promise<void> {
  const path = await addChangeWorkspace(backend, change);
  await openWorkspaceWindow(path);
}

/** Remove the workspaces of landed and archived changes, reporting the tally in the status bar. */
async function runReclaim(provider: PageProvider): Promise<void> {
  try {
    const backend = await openBackend();
    const reclaimed = await reclaimWorkspaces(backend, false);
    vscode.window.setStatusBarMessage(`cabaret: ${reclaimNote(reclaimed)}`, 5000);
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: ${message(error)}`);
  } finally {
    provider.refreshAll();
  }
}

/** Remove `change`'s workspace, confirming before uncommitted changes are discarded. */
async function removeWorkspaceSelection(backend: Backend, change: ChangeName): Promise<void> {
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
function singleChange(changes: readonly ChangeName[], action: string): ChangeName | undefined {
  const only = changes.length === 1 ? changes[0] : undefined;
  if (only === undefined) {
    vscode.window.showInformationMessage(`cabaret: select a single change to ${action}`);
  }
  return only;
}

/** Prompt for a name and create a change with `parent` as its parent, returning the new name. */
async function promptCreate(backend: Backend, parent: ChangeName, prompt: string): Promise<ChangeName | undefined> {
  const raw = await vscode.window.showInputBox({ prompt, validateInput: invalidName(backend) });
  if (raw === undefined) {
    return undefined;
  }
  const change = backend.parseName(raw);
  await createChange(backend, now, change, parent);
  return change;
}

/** Pick a new parent for `change`: any other change, or a trunk. */
async function pickParent(backend: Backend, change: ChangeName): Promise<ChangeName | undefined> {
  const candidates = (await knownChanges(backend)).filter((candidate) => candidate !== change);
  const picked = await vscode.window.showQuickPick([...candidates], {
    placeHolder: `New parent for ${change}`,
  });
  return picked === undefined ? undefined : backend.parseName(picked);
}

/** Prompt for a new name and rename `from`, following a renamed show page to its new name. */
async function rename(
  provider: PageProvider,
  backend: Backend,
  editor: vscode.TextEditor,
  from: ChangeName,
): Promise<void> {
  const raw = await vscode.window.showInputBox({
    prompt: `Rename ${from}`,
    value: from,
    validateInput: invalidName(backend),
  });
  if (raw === undefined || raw === from) {
    return;
  }
  const to = backend.parseName(raw);
  if (!(await confirmNotOwner("Rename Anyway", (override) => renameChange(backend, from, to, override)))) {
    return;
  }
  // A show page's URI names the change, so the old page cannot re-render;
  // forget it before the post-action refresh and replace it with the page
  // under the new name.
  const page = parsePagePath(editor.document.uri.path);
  if (page.kind === "show") {
    provider.forget(editor.document.uri);
    await closeTabs(editor.document.uri);
    await openPage(provider, { kind: "show", change: to, as: page.as });
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
    // Status foregrounds recolor the text itself: a table cell, not a wash.
    ready: vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor("cabaret.readyForeground"),
    }),
    blocked: vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor("cabaret.blockedForeground"),
    }),
    nudge: vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor("cabaret.nudgeForeground"),
    }),
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
      ready: [],
      blocked: [],
      nudge: [],
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
  try {
    writePageGrammar(context);
  } catch (error) {
    vscode.window.showErrorMessage(`cabaret: writing the page grammar failed — ${message(error)}`);
  }
  const provider = new PageProvider();
  const decorations = createDecorations();
  const repaint = (): void => paintVisible(provider, decorations);
  const forgePollLoop = createForgePollLoop(provider);
  // A borrowed identity announces itself beside the page, where it cannot be
  // scrolled away; clicking it offers the swap.
  const actingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  actingStatus.command = "cabaret.actAs";
  const updateActingStatus = (editor: vscode.TextEditor | undefined): void => {
    const as = editor?.document.uri.scheme === SCHEME ? parsePagePath(editor.document.uri.path).as : undefined;
    if (as === undefined) {
      actingStatus.hide();
    } else {
      actingStatus.text = `cabaret: as ${as}`;
      actingStatus.show();
    }
  };
  localSyncLoop.start();
  forgePollLoop.start();
  // Tabbing back in is a good moment to catch up sooner than the next
  // scheduled poll — but rapid alt-tabbing should not turn into rapid
  // polling, so this only fires again after a real gap since the last one.
  let lastOpportunisticPollAt = 0;
  context.subscriptions.push(
    { dispose: () => localSyncLoop.dispose() },
    { dispose: () => forgePollLoop.dispose() },
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !backgroundSyncEnabled()) {
        return;
      }
      const at = Date.now();
      if (at - lastOpportunisticPollAt < 30_000) {
        return;
      }
      lastOpportunisticPollAt = at;
      void forgePollLoop.runNow();
    }),
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
    actingStatus,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updatePageContext(editor);
      updateActingStatus(editor);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cabaret.context")) {
        provider.refreshAll();
      }
    }),
    vscode.commands.registerCommand("cabaret.home", () => openPage(provider, { kind: "home" })),
    vscode.commands.registerCommand("cabaret.show", () => showChange(provider)),
    vscode.commands.registerCommand("cabaret.openTarget", () => openTarget(provider)),
    vscode.commands.registerCommand("cabaret.stepOutside", () => stepOutside(provider)),
    vscode.commands.registerCommand("cabaret.stepUp", () => stepUp(provider)),
    vscode.commands.registerCommand("cabaret.stepDown", () => stepDown(provider)),
    vscode.commands.registerCommand("cabaret.help", () => showHelp(context.extension.packageJSON as Manifest)),
    vscode.commands.registerCommand("cabaret.review", () => review(provider)),
    vscode.commands.registerCommand("cabaret.reviewDiffs", () => reviewDiffs(provider)),
    vscode.commands.registerCommand("cabaret.actAs", () => actAs(provider)),
    vscode.commands.registerCommand("cabaret.markReviewed", () => markPageReviewed(provider)),
    vscode.commands.registerCommand("cabaret.fetch", () => runFetch(provider, forgePollLoop)),
    vscode.commands.registerCommand("cabaret.setup", () => runSetup()),
    vscode.commands.registerCommand("cabaret.sync", () =>
      actOnSelection(provider, (backend, _editor, changes) => syncSelection(backend, changes)),
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
        if (change !== undefined) {
          await reparentSelection(backend, change);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.setOwner", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const raw = await vscode.window.showInputBox({
          prompt: `New owner for ${changes.join(", ")}`,
          validateInput: (value) => (value === "" ? "owner must be nonempty" : undefined),
        });
        if (raw === undefined) {
          return;
        }
        const done = new Set<ChangeName>();
        await confirmNotOwner("Set Owner Anyway", async (override) => {
          for (const change of changes) {
            if (!done.has(change)) {
              await transferChange(backend, now, change, userName(raw), override);
              done.add(change);
            }
          }
        });
      }),
    ),
    vscode.commands.registerCommand("cabaret.widenReviewing", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const change = singleChange(changes, "widen reviewing of");
        if (change !== undefined) {
          await widenSelection(backend, change);
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.disableReviewing", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        for (const change of changes) {
          await setReviewing(backend, now, change, await backend.readLog(change), "none");
        }
      }),
    ),
    vscode.commands.registerCommand("cabaret.toggleArchived", () =>
      actOnSelection(provider, async (backend, _editor, changes) => {
        const archived: ChangeName[] = [];
        const unarchived: ChangeName[] = [];
        for (const change of changes) {
          const entries = await backend.readLog(change);
          const target = !currentArchived(entries);
          await setArchived(backend, now, change, entries, target);
          (target ? archived : unarchived).push(change);
        }
        const report = [
          ...(archived.length > 0 ? [`${archived.join(", ")} archived`] : []),
          ...(unarchived.length > 0 ? [`${unarchived.join(", ")} unarchived`] : []),
        ].join("; ");
        vscode.window.showInformationMessage(`cabaret: ${report}`);
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
    vscode.commands.registerCommand("cabaret.reclaimWorkspaces", () => runReclaim(provider)),
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
  updateActingStatus(vscode.window.activeTextEditor);
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

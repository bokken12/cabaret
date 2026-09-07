import {
  Cabaret,
  type ChangedFile,
  type ChangeId,
  type Page,
  type RepoPath,
  type Revision,
  type Segment,
  type SessionId,
  type Tag,
  type Target,
} from "@cabaret/node";
import * as vscode from "vscode";

const SCHEME = "cabaret";
const BLOB_SCHEME = "cabaret-blob";
const DESCRIPTION_SCHEME = "cabaret-description";

/** The cabaret workspace this window is open on. */
function workspaceFolder(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder === undefined) {
    throw new Error("no workspace folder open");
  }
  return folder;
}

let session: { dir: string; cabaret: Cabaret } | undefined;

function openCabaret(): Cabaret {
  const dir = workspaceFolder().fsPath;
  if (session?.dir !== dir) {
    session = { dir, cabaret: new Cabaret(dir) };
  }
  return session.cabaret;
}

/**
 * The two diffs of a change: `diff` from its base to its tip, `workspace` from its tip to what the
 * workspace holding it has on disk.
 */
type View = "diff" | "workspace";

type Route = { kind: "home" } | { kind: "show" | View; change: ChangeId };

function routeUri(route: Route): vscode.Uri {
  const path = route.kind === "home" ? "/home" : `/${route.kind}/${route.change}`;
  return vscode.Uri.from({ scheme: SCHEME, path });
}

function parseRoute(uri: vscode.Uri): Route {
  if (uri.path === "/home") {
    return { kind: "home" };
  }
  const [, kind, change] = /^\/(show|diff|workspace)\/(.+)$/.exec(uri.path) ?? [];
  if ((kind !== "show" && kind !== "diff" && kind !== "workspace") || change === undefined) {
    throw new Error(`unknown page ${uri.toString()}`);
  }
  return { kind, change };
}

/** A file in the workspace, as Enter on a file diff leads to. */
type Location = { kind: "file"; path: RepoPath; line: number };

type Destination = Route | Location;

async function openFile({ path, line }: Location): Promise<void> {
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(vscode.Uri.joinPath(workspaceFolder(), path), {
    selection: new vscode.Range(position, position),
  });
}

function renderRoute(cabaret: Cabaret, route: Route): Promise<Page> {
  switch (route.kind) {
    case "home":
      return cabaret.homePage();
    case "show":
      return cabaret.showPage(route.change);
    case "diff":
      return cabaret.diffPage(route.change);
    case "workspace":
      return cabaret.workspacePage(route.change);
  }
}

/**
 * The sessions tail of a show page. A failure to list is reported in place of the list rather
 * than failing the page.
 */
async function sessionsPage(cabaret: Cabaret, change: ChangeId): Promise<Page> {
  try {
    return await cabaret.sessionsPage(change);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      lines: [{ segments: [] }, { segments: [{ text: `Sessions: unavailable (${message})`, tag: "Muted" }] }],
      folds: [],
    };
  }
}

function pageText(page: Page): string {
  return page.lines.map((line) => `${line.segments.map((segment) => segment.text).join("")}\n`).join("");
}

/** Every segment with its range in the rendered text. */
function* placed(page: Page): Generator<{ segment: Segment; range: vscode.Range }> {
  for (const [line, { segments }] of page.lines.entries()) {
    let start = 0;
    for (const segment of segments) {
      const end = start + segment.text.length;
      yield { segment, range: new vscode.Range(line, start, line, end) };
      start = end;
    }
  }
}

/** A targeted segment under the cursor, else the line's own target. */
function targetAt(page: Page, position: vscode.Position): Target | undefined {
  const line = page.lines[position.line];
  if (line === undefined) {
    return undefined;
  }
  let start = 0;
  for (const segment of line.segments) {
    const end = start + segment.text.length;
    if (segment.target !== undefined && position.character >= start && position.character < end) {
      return segment.target;
    }
    start = end;
  }
  return line.target;
}

const themed = (color: string): vscode.DecorationRenderOptions => ({ color: new vscode.ThemeColor(color) });

const STYLES: Record<Tag, vscode.DecorationRenderOptions> = {
  Heading: { fontWeight: "bold" },
  ChangeId: themed("textLink.foreground"),
  Revision: themed("textPreformat.foreground"),
  Label: themed("descriptionForeground"),
  Muted: themed("descriptionForeground"),
  Added: themed("gitDecoration.addedResourceForeground"),
  Deleted: themed("gitDecoration.deletedResourceForeground"),
  Modified: themed("gitDecoration.modifiedResourceForeground"),
  Renamed: themed("gitDecoration.renamedResourceForeground"),
  Copied: themed("gitDecoration.addedResourceForeground"),
};

const TAGS = Object.keys(STYLES) as Tag[];

/** The page or, for a file diff, the after side a tab shows, when it is one of ours. */
function cabaretTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText && input.uri.scheme === SCHEME) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff && blobSide(input) !== undefined) {
    return input.modified;
  }
  return undefined;
}

/** A side of a two-sided diff that is one of our blobs; a file diff of ours has at least one. */
function blobSide(input: vscode.TabInputTextDiff): vscode.Uri | undefined {
  return [input.modified, input.original].find((uri) => uri.scheme === BLOB_SCHEME);
}

/**
 * `open` something identified by `destination`, then close the cabaret tab it was opened from:
 * moving around cabaret replaces the view, as in a browser, rather than piling up tabs.
 */
async function replacingActive(destination: vscode.Uri, open: () => Promise<void>): Promise<void> {
  const from = vscode.window.tabGroups.activeTabGroup.activeTab;
  await open();
  const fromUri = from === undefined ? undefined : cabaretTabUri(from);
  if (from !== undefined && fromUri !== undefined && fromUri.toString() !== destination.toString()) {
    await vscode.window.tabGroups.close(from);
  }
}

/** Serves `cabaret:` pages and paints their tags onto whichever editors show them. */
class PageProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.FoldingRangeProvider
{
  private readonly pages = new Map<string, Page>();
  /** Pages completed by a late part, to serve on the re-read that `changed` triggers. */
  private readonly completed = new Map<string, Page>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly decorations = Object.fromEntries(
    TAGS.map((tag) => [tag, vscode.window.createTextEditorDecorationType(STYLES[tag])]),
  ) as Record<Tag, vscode.TextEditorDecorationType>;
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const completed = this.completed.get(key);
    if (completed !== undefined) {
      this.completed.delete(key);
      this.pages.set(key, completed);
      return pageText(completed);
    }
    const route = parseRoute(uri);
    const page = await renderRoute(openCabaret(), route);
    this.pages.set(key, page);
    if (route.kind === "show") {
      void this.addSessions(uri, page, route.change);
    }
    return pageText(page);
  }

  /**
   * Listing sessions reads every transcript in the workspace, which is slow next to reading the
   * repository, so a show page renders without them and grows a tail when they arrive, unless it
   * was re-rendered meanwhile.
   */
  private async addSessions(uri: vscode.Uri, page: Page, change: ChangeId): Promise<void> {
    const tail = await sessionsPage(openCabaret(), change);
    const key = uri.toString();
    // A closed document is not re-read on `changed`, so a completed page would wait to be served
    // stale on the next open.
    const open = vscode.workspace.textDocuments.some((document) => document.uri.toString() === key);
    if (tail.lines.length === 0 || !open || this.pages.get(key) !== page) {
      return;
    }
    const offset = page.lines.length;
    this.completed.set(key, {
      lines: [...page.lines, ...tail.lines],
      folds: [...page.folds, ...tail.folds.map(({ start, end }) => ({ start: start + offset, end: end + offset }))],
    });
    this.changed.fire(uri);
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const page = this.pages.get(document.uri.toString());
    if (page === undefined) {
      return [];
    }
    return [...placed(page)].flatMap(({ segment, range }) => {
      const target = segment.target;
      return target?.kind === "Change"
        ? [new vscode.DocumentLink(range, routeUri({ kind: "show", change: target.change }))]
        : [];
    });
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const page = this.pages.get(document.uri.toString());
    return (page?.folds ?? []).map((fold) => new vscode.FoldingRange(fold.start, fold.end));
  }

  page(uri: vscode.Uri): Page | undefined {
    return this.pages.get(uri.toString());
  }

  targetUnderCursor(editor: vscode.TextEditor): Target | undefined {
    const page = this.page(editor.document.uri);
    return page === undefined ? undefined : targetAt(page, editor.selection.active);
  }

  decorate(editor: vscode.TextEditor): void {
    const page = this.page(editor.document.uri);
    if (page === undefined) {
      return;
    }
    const tagged = [...placed(page)].flatMap(({ segment, range }) =>
      segment.tag === undefined ? [] : [{ tag: segment.tag, range }],
    );
    const ranges = Map.groupBy(tagged, ({ tag }) => tag);
    for (const tag of TAGS) {
      editor.setDecorations(
        this.decorations[tag],
        (ranges.get(tag) ?? []).map(({ range }) => range),
      );
    }
  }

  /** Drop what was rendered for `route`, so an open document of it re-reads the repository. */
  invalidate(route: Route): vscode.Uri {
    const uri = routeUri(route);
    this.completed.delete(uri.toString());
    this.changed.fire(uri);
    return uri;
  }

  /** Re-render `route` from the repository and show it. */
  async open(route: Route): Promise<void> {
    const uri = this.invalidate(route);
    await replacingActive(uri, async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      this.decorate(await vscode.window.showTextDocument(document, { preview: false }));
    });
  }

  async show(destination: Destination): Promise<void> {
    if (destination.kind === "file") {
      await openFile(destination);
    } else {
      await this.open(destination);
    }
  }
}

/** One file of a change's `view`, as a two-sided diff shows it. */
type FileDiff = { view: View; change: ChangeId; path: RepoPath };

/**
 * `cabaret-blob:/<blob path>?view=<view>&change=<id>&path=<path>[&revision=<rev>]`: the text at
 * `blobPath` in that revision, or empty with no revision, as one side of the file diff the query
 * names. The blob's own path differs from the diff's for the before side of a rename.
 */
function blobUri(diff: FileDiff, revision: Revision | undefined, blobPath: RepoPath): vscode.Uri {
  const query = new URLSearchParams(diff);
  if (revision !== undefined) {
    query.set("revision", revision);
  }
  return vscode.Uri.from({ scheme: BLOB_SCHEME, path: `/${blobPath}`, query: query.toString() });
}

/** The file diff a blob is a side of. */
function blobFileDiff(uri: vscode.Uri): FileDiff {
  const query = new URLSearchParams(uri.query);
  const [view, change, path] = [query.get("view"), query.get("change"), query.get("path")];
  if ((view !== "diff" && view !== "workspace") || change === null || path === null) {
    throw new Error(`${uri.toString()} names no file diff`);
  }
  return { view, change, path };
}

class BlobProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const revision = new URLSearchParams(uri.query).get("revision");
    return revision === null ? "" : ((await openCabaret().blob(revision, uri.path.slice(1))) ?? "");
  }
}

/** `cabaret-description:/<change>.md`: the change's description, as markdown. */
function descriptionUri(change: ChangeId): vscode.Uri {
  return vscode.Uri.from({ scheme: DESCRIPTION_SCHEME, path: `/${change}.md` });
}

function descriptionChange(uri: vscode.Uri): ChangeId {
  const [, change] = /^\/(.+)\.md$/.exec(uri.path) ?? [];
  if (change === undefined) {
    throw new Error(`${uri.toString()} names no change`);
  }
  return change;
}

/**
 * Serves each change's description as a file to edit in place, with a save written to the
 * change's log. Descriptions never change underneath an editor as far as VS Code can tell, so a
 * save always goes through rather than raising a conflict.
 */
class DescriptionProvider implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  constructor(private readonly pages: PageProvider) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await this.readFile(uri)).byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { description } = await openCabaret().change(descriptionChange(uri));
    return Buffer.from(description ?? "");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const change = descriptionChange(uri);
    const text = Buffer.from(content).toString();
    await openCabaret().setDescription(change, text.trim() === "" ? undefined : text);
    this.pages.invalidate({ kind: "show", change });
  }

  readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
}

async function beforeRevision(cabaret: Cabaret, change: ChangeId, file: ChangedFile): Promise<Revision | undefined> {
  if (file.kind === "Added") {
    return undefined;
  }
  const base = await cabaret.base(change);
  if (base === null) {
    throw new Error(`${change} has no base, yet ${file.path} was not added`);
  }
  return base;
}

/**
 * The before and after sides of `file` in `diff`. Blobs, except that the workspace view's after
 * side is the file on disk itself, so it stays live and can be edited in place.
 */
async function sides(cabaret: Cabaret, diff: FileDiff, file: ChangedFile): Promise<[vscode.Uri, vscode.Uri]> {
  const { change } = diff;
  const from = "from" in file ? file.from : file.path;
  const { tip } = await cabaret.change(change);
  switch (diff.view) {
    case "diff":
      return [
        blobUri(diff, await beforeRevision(cabaret, change, file), from),
        blobUri(diff, file.kind === "Deleted" ? undefined : tip, file.path),
      ];
    case "workspace": {
      const before = blobUri(diff, file.kind === "Added" ? undefined : tip, from);
      if (file.kind === "Deleted") {
        return [before, blobUri(diff, undefined, file.path)];
      }
      return [before, vscode.Uri.joinPath(vscode.Uri.file(await cabaret.workspacePath(change)), file.path)];
    }
  }
}

async function openFileDiff(cabaret: Cabaret, view: View, change: ChangeId, file: ChangedFile): Promise<void> {
  const diff: FileDiff = { view, change, path: file.path };
  const [before, after] = await sides(cabaret, diff, file);
  const title = view === "diff" ? `${file.path} (${change})` : `${file.path} (${change}, uncommitted)`;
  // Pinned: a preview would take over the tab about to be closed.
  const options = { preview: false } satisfies vscode.TextDocumentShowOptions;
  await replacingActive(after, async () => {
    await vscode.commands.executeCommand("vscode.diff", before, after, title, options);
  });
}

async function follow(cabaret: Cabaret, provider: PageProvider, target: Target): Promise<void> {
  switch (target.kind) {
    case "Change":
      await provider.open({ kind: "show", change: target.change });
      break;
    case "Diff":
      await openFileDiff(cabaret, "diff", target.change, target.file);
      break;
    case "WorkspaceDiff":
      await openFileDiff(cabaret, "workspace", target.change, target.file);
      break;
    case "Title":
      await editTitle(cabaret, provider, target.change);
      break;
    case "Description":
      await editDescription(target.change);
      break;
    case "Session":
      await openSession(cabaret, target.change, target.session);
      break;
  }
}

async function editDescription(change: ChangeId): Promise<void> {
  await vscode.window.showTextDocument(descriptionUri(change));
}

/** Titles are one line, so they are edited in an input box rather than a buffer like descriptions. */
async function editTitle(cabaret: Cabaret, provider: PageProvider, change: ChangeId): Promise<void> {
  const { title } = await cabaret.change(change);
  const edited = (
    await vscode.window.showInputBox({
      title: `Cabaret: Edit Title of ${change}`,
      value: title,
      prompt: "Title of the change, blank for none",
      ignoreFocusOut: true,
    })
  )?.trim();
  if (edited === undefined || edited === (title ?? "")) {
    return;
  }
  await cabaret.setTitle(change, edited === "" ? undefined : edited);
  provider.invalidate({ kind: "show", change });
}

/** Terminals showing a resumed session, so a second Enter reveals the same one. */
const sessionTerminals = new Map<SessionId, vscode.Terminal>();

/**
 * Resume a Claude Code session in its own editor tab, running the CLI through the user's shell in
 * the workspace it was launched from.
 */
async function openSession(cabaret: Cabaret, change: ChangeId, session: SessionId): Promise<void> {
  const existing = sessionTerminals.get(session);
  if (existing !== undefined) {
    existing.show();
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: `claude ${session.slice(0, 8)}`,
    cwd: await cabaret.workspacePath(change),
    location: vscode.TerminalLocation.Editor,
  });
  sessionTerminals.set(session, terminal);
  terminal.sendText(`claude --resume ${session}`);
  terminal.show();
}

/** The change a page is about: on the home page the one under the cursor, else the page's own. */
function pageChange(provider: PageProvider, editor: vscode.TextEditor): ChangeId | undefined {
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "home") {
    return route.change;
  }
  const target = provider.targetUnderCursor(editor);
  return target?.kind === "Change" ? target.change : undefined;
}

function activePage(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === SCHEME ? editor : undefined;
}

/** The file diff the active tab shows, if it is one. */
function activeFileDiff(): FileDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const blob = input instanceof vscode.TabInputTextDiff ? blobSide(input) : undefined;
  return blob === undefined ? undefined : blobFileDiff(blob);
}

type PageKind = Route["kind"] | "file";

/** Expose the active page's kind as the `cabaret.page` context, so keybindings can scope to pages. */
function updatePageContext(): void {
  const editor = activePage();
  const kind: PageKind | undefined =
    activeFileDiff() !== undefined ? "file" : editor === undefined ? undefined : parseRoute(editor.document.uri).kind;
  vscode.commands.executeCommand("setContext", "cabaret.page", kind);
}

/** The scope enclosing a page: a change's diffs sit in its show page, which sits in home. */
function enclosing(route: Route): Route | undefined {
  switch (route.kind) {
    case "home":
      return undefined;
    case "show":
      return { kind: "home" };
    case "diff":
    case "workspace":
      return { kind: "show", change: route.change };
  }
}

/**
 * The change the active file diff or page is about, or a workspace file's checked-out one; where
 * nothing on screen implies a change, one picked by the user, undefined if they decline.
 */
async function activeChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId | undefined> {
  return (await impliedChange(cabaret, provider)) ?? pickChange(cabaret, "Cabaret: Choose Change");
}

/** A new change with no parent in view most often wants to start off trunk, so skip the picker. */
async function parentForNewChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId> {
  return (await impliedChange(cabaret, provider)) ?? cabaret.trunk();
}

async function impliedChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId | undefined> {
  const fileDiff = activeFileDiff();
  if (fileDiff !== undefined) {
    return fileDiff.change;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return undefined;
  }
  if (editor.document.uri.scheme === SCHEME) {
    return pageChange(provider, editor);
  }
  if (editor.document.uri.scheme === DESCRIPTION_SCHEME) {
    return descriptionChange(editor.document.uri);
  }
  return vscode.workspace.getWorkspaceFolder(editor.document.uri) === undefined ? undefined : cabaret.currentChange();
}

<<<<<<< live-diff
async function openPage(cabaret: Cabaret, provider: PageProvider, kind: "show" | View): Promise<void> {
  const change = await activeChange(cabaret, provider);
  if (change !== undefined) {
    await provider.open({ kind, change });
  }
||||||| base
async function openPage(cabaret: Cabaret, provider: PageProvider, kind: "show" | "diff"): Promise<void> {
  const change = await activeChange(cabaret, provider);
  if (change !== undefined) {
    await provider.open({ kind, change });
  }
=======
/** `run` on the change the active page is about, or one the user picks; nothing if they decline. */
function onChange(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<void>,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const change = await activeChange(cabaret, provider);
    if (change !== undefined) {
      await run(cabaret, change);
    }
  });
>>>>>>> main
}

/** The row leading to `change` nearest `near`; the home page may draw a change in both sections. */
function rowOf(page: Page, change: ChangeId, near: number): number | undefined {
  const rows = page.lines.flatMap((line, row) =>
    line.target?.kind === "Change" && line.target.change === change ? [row] : [],
  );
  return rows.length === 0
    ? undefined
    : rows.reduce((best, row) => (Math.abs(row - near) < Math.abs(best - near) ? row : best));
}

type Direction = "up" | "down";

/** On a file diff, `^`/`$` go to the file above or below it in the same view of the change. */
async function stepFile(cabaret: Cabaret, { view, change, path }: FileDiff, direction: Direction): Promise<void> {
  const files = await (view === "diff" ? cabaret.changedFiles(change) : cabaret.workspaceFiles(change));
  const index = files.findIndex((file) => file.path === path);
  if (index === -1) {
    throw new Error(`${path} is no longer in ${change}'s diff`);
  }
  const file = files[direction === "up" ? index - 1 : index + 1];
  if (file === undefined) {
    const end = direction === "up" ? "first" : "last";
    vscode.window.setStatusBarMessage(`Cabaret: ${path} is the ${end} file in ${change}`, 3000);
    return;
  }
  await openFileDiff(cabaret, view, change, file);
}

/**
 * Step from the change the active page is about to one of its parents or children: on the home
 * page by moving the cursor onto its row, or opening it when it is not drawn there; on a change's
 * page by opening the same kind of page for it. On a file diff, step between the change's files.
 */
async function step(cabaret: Cabaret, provider: PageProvider, direction: Direction): Promise<void> {
  const fileDiff = activeFileDiff();
  if (fileDiff !== undefined) {
    await stepFile(cabaret, fileDiff, direction);
    return;
  }
  const editor = activePage();
  if (editor === undefined) {
    return;
  }
  const from = pageChange(provider, editor);
  if (from === undefined) {
    return;
  }
  const relation = direction === "up" ? "parents" : "children";
  const candidates = [...(direction === "up" ? (await cabaret.change(from)).parents : await cabaret.children(from))];
  if (candidates.length === 0) {
    vscode.window.setStatusBarMessage(`Cabaret: ${from} has no ${relation}`, 3000);
    return;
  }
  const to =
    candidates.length === 1
      ? candidates[0]
      : await vscode.window.showQuickPick(candidates, { title: `Cabaret: ${relation} of ${from}` });
  if (to === undefined) {
    return;
  }
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "home") {
    await provider.open({ ...route, change: to });
    return;
  }
  const page = provider.page(editor.document.uri);
  const row = page === undefined ? undefined : rowOf(page, to, editor.selection.active.line);
  if (row === undefined) {
    await provider.open({ kind: "show", change: to });
    return;
  }
  const position = editor.document.validatePosition(new vscode.Position(row, editor.selection.active.character));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

async function pickChange(cabaret: Cabaret, title: string): Promise<ChangeId | undefined> {
  const current = await cabaret.currentChange();
  const items = (await cabaret.changes()).map((change) => ({
    label: change,
    description: change === current ? "current" : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: items.length === 0 ? "no changes" : undefined,
  });
  return picked?.label;
}

async function reporting(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    vscode.window.showErrorMessage(`Cabaret: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function command(name: string, run: (cabaret: Cabaret) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, () => reporting(() => run(openCabaret())));
}

/**
 * What a window opened on another workspace should show first, in global state since a new
 * window starts its own extension host. Dated, as the window never starts when the folder is
 * already open elsewhere, and a handoff must not surprise a later start.
 */
type Handoff = { destination: Destination; at: number };

const HANDOFF_TTL = 60_000;

const handoffKey = (dir: string): string => `handoff:${dir}`;

/** Open the workspace at `dir` in a new window, showing `destination` there. */
async function openWorkspace(
  context: vscode.ExtensionContext,
  dir: string,
  destination: Destination | undefined,
): Promise<void> {
  if (destination !== undefined) {
    const handoff: Handoff = { destination, at: Date.now() };
    await context.globalState.update(handoffKey(dir), handoff);
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true });
}

/** On startup, show what a window elsewhere left for this window's workspace. */
async function takeHandoff(context: vscode.ExtensionContext, provider: PageProvider): Promise<void> {
  if (vscode.workspace.workspaceFolders === undefined) {
    return;
  }
  const dir = workspaceFolder().fsPath;
  const handoff = context.globalState.get<Handoff>(handoffKey(dir));
  if (handoff === undefined) {
    return;
  }
  await context.globalState.update(handoffKey(dir), undefined);
  if (Date.now() - handoff.at < HANDOFF_TTL) {
    await provider.show(handoff.destination);
  }
}

/** The file at the cursor on the active file diff. */
function cursorLocation({ path }: FileDiff): Location {
  // Read off whichever side holds the cursor, so only approximate on the before side.
  const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
  return { kind: "file", path, line };
}

/** The file at the cursor on the active file diff, else the active page. */
function activeDestination(): Destination | undefined {
  const fileDiff = activeFileDiff();
  if (fileDiff !== undefined) {
    return cursorLocation(fileDiff);
  }
  const editor = activePage();
  return editor === undefined ? undefined : parseRoute(editor.document.uri);
}

async function gotoWorkspace(
  context: vscode.ExtensionContext,
  cabaret: Cabaret,
  provider: PageProvider,
): Promise<void> {
  const change = await activeChange(cabaret, provider);
  if (change === undefined) {
    return;
  }
  await openWorkspace(context, await cabaret.workspacePath(change), activeDestination());
}

/**
 * Enter on a file diff: the file itself at the cursor's line, in the change's workspace. Without
 * one, offer to check the change out here, or where this workspace is another change's own, to
 * make it a workspace and open that in a new window.
 */
async function enterFile(context: vscode.ExtensionContext, cabaret: Cabaret, fileDiff: FileDiff): Promise<void> {
  const { change } = fileDiff;
  const location = cursorLocation(fileDiff);
  const placement = await cabaret.placement(change);
  switch (placement.kind) {
    case "Here":
      await openFile(location);
      return;
    case "Elsewhere":
      await openWorkspace(context, await cabaret.workspacePath(change), location);
      return;
    case "Nowhere": {
      const offer = placement.dedicated ? "Create Workspace" : "Check Out Here";
      const detail = placement.dedicated
        ? `Create a workspace for ${change} and open ${location.path} there in a new window.`
        : `Check ${change} out in this workspace and open ${location.path}.`;
      const message = `Cabaret: ${change} is not checked out in any workspace`;
      if ((await vscode.window.showInformationMessage(message, { modal: true, detail }, offer)) === undefined) {
        return;
      }
      if (placement.dedicated) {
        await openWorkspace(context, await cabaret.workspaceAdd(change), location);
      } else {
        await cabaret.workspaceSwitch(change);
        await openFile(location);
      }
    }
  }
}

/** Re-render the active page from the repository. */
async function refresh(provider: PageProvider): Promise<void> {
  const editor = activePage();
  if (editor !== undefined) {
    await provider.open(parseRoute(editor.document.uri));
  }
}

/** What an action did, and the page its result is on when not the active one. */
type Outcome = string | { report: string; show: Route };

/**
 * `!` then a key: `run` acts on the change the active page is about, found by `subject`, and says
 * what it did, or nothing when the user backed out; the page is then re-rendered to show the
 * result, or the page `run` names is opened instead.
 */
function action(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<Outcome | undefined>,
  subject: (cabaret: Cabaret, provider: PageProvider) => Promise<ChangeId | undefined> = activeChange,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const change = await subject(cabaret, provider);
    if (change === undefined) {
      return;
    }
    const outcome = await run(cabaret, change);
    if (outcome === undefined) {
      return;
    }
    const { report, show } = typeof outcome === "string" ? { report: outcome, show: undefined } : outcome;
    vscode.window.showInformationMessage(`Cabaret: ${report}`);
    await (show === undefined ? refresh(provider) : provider.open(show));
  });
}

const words = (ids: Iterable<string>): string => [...ids].join(", ");

async function rebase(cabaret: Cabaret, change: ChangeId): Promise<string> {
  const rebase = await cabaret.rebase(change);
  const report = [
    rebase.merged.size === 0 ? `${change} is already up to date` : `rebased ${change} onto ${words(rebase.merged)}`,
  ];
  if (rebase.conflicts.size > 0) {
    report.push(`conflicts in ${words(rebase.conflicts)}`);
  }
  if (rebase.remaining.size > 0) {
    report.push(`resolve them and rebase again to continue onto ${words(rebase.remaining)}`);
  }
  return report.join("; ");
}

function askChangeName(title: string): Thenable<ChangeId | undefined> {
  return vscode.window.showInputBox({ title, prompt: "Name of the new change", ignoreFocusOut: true });
}

async function createChild(cabaret: Cabaret, parent: ChangeId): Promise<Outcome | undefined> {
  const child = await askChangeName(`Cabaret: Create Child of ${parent}`);
  if (child === undefined) {
    return undefined;
  }
  await cabaret.create(child, parent);
  return { report: `created ${child} with parent ${parent}`, show: { kind: "show", change: child } };
}

async function createParent(cabaret: Cabaret, child: ChangeId): Promise<Outcome | undefined> {
  const parent = await askChangeName(`Cabaret: Create Parent of ${child}`);
  if (parent === undefined) {
    return undefined;
  }
  await cabaret.createParent(parent, child);
  return { report: `created ${parent} as parent of ${child}`, show: { kind: "show", change: parent } };
}

async function addOwner(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const owner = await vscode.window.showInputBox({
    title: `Cabaret: Add Owner of ${change}`,
    prompt: "Email of the new owner",
    ignoreFocusOut: true,
  });
  if (owner === undefined) {
    return undefined;
  }
  await cabaret.addOwner(change, owner);
  return `added ${owner} as an owner of ${change}`;
}

async function removeOwner(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const { owners } = await cabaret.change(change);
  const owner = await vscode.window.showQuickPick([...owners], { title: `Cabaret: Remove Owner of ${change}` });
  if (owner === undefined) {
    return undefined;
  }
  await cabaret.removeOwner(change, owner);
  return `removed ${owner} as an owner of ${change}`;
}

async function addParent(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const parent = await pickChange(cabaret, `Cabaret: Add Parent of ${change}`);
  if (parent === undefined) {
    return undefined;
  }
  await cabaret.addParent(change, parent);
  return `added ${parent} as a parent of ${change}`;
}

async function removeParent(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const parents = [...(await cabaret.change(change)).declaredParents];
  const parent = await vscode.window.showQuickPick(parents, {
    title: `Cabaret: Remove Parent of ${change}`,
    placeHolder: parents.length === 0 ? `${change} declares no parents` : undefined,
  });
  if (parent === undefined) {
    return undefined;
  }
  await cabaret.removeParent(change, parent);
  return `removed ${parent} as a parent of ${change}`;
}

/**
 * Start a headless Claude Code session on `change` with a prompt from the user, first offering to
 * create a workspace for a change checked out nowhere.
 */
async function startSession(cabaret: Cabaret, change: ChangeId): Promise<string | undefined> {
  const prompt = await vscode.window.showInputBox({
    title: `Cabaret: Start Session on ${change}`,
    prompt: "What should the agent do?",
    ignoreFocusOut: true,
  });
  if (prompt === undefined || prompt === "") {
    return undefined;
  }
  if ((await cabaret.placement(change)).kind === "Nowhere") {
    const create = await vscode.window.showWarningMessage(
      `${change} is not checked out in any workspace. Create one for it?`,
      { modal: true },
      "Create Workspace",
    );
    if (create === undefined) {
      return undefined;
    }
    await cabaret.workspaceAdd(change);
  }
  const args = vscode.workspace
    .getConfiguration("cabaret")
    .get<string[]>("sessionArgs", ["--permission-mode", "auto", "--permission-prompts", "none"]);
  await cabaret.startSession(change, prompt, args);
  return `started a session on ${change}`;
}

/**
 * Land, then offer to remove the workspace that held the change, since an archived change has
 * nothing left to do there. A permanent change stays open, so its workspace is not offered.
 */
async function land(cabaret: Cabaret, change: ChangeId): Promise<string> {
  const landed = `landed ${change} into ${await cabaret.land(change)}`;
  const { archived, workspace } = await cabaret.change(change);
  if (!archived || workspace === undefined) {
    return landed;
  }
  const remove = await vscode.window.showInformationMessage(
    `Cabaret: ${landed}`,
    { modal: true, detail: `Remove the workspace ${workspace} that held it?` },
    "Remove Workspace",
  );
  if (remove === undefined) {
    return landed;
  }
  await cabaret.workspaceRemove(change);
  return `${landed}; removed workspace ${workspace}`;
}

async function toggleArchived(cabaret: Cabaret, change: ChangeId): Promise<string> {
  return `${(await cabaret.toggleArchived(change)) ? "archived" : "unarchived"} ${change}`;
}

async function commitAll(cabaret: Cabaret, change: ChangeId): Promise<string> {
  await cabaret.commit(change, []);
  return `committed all files to ${change}`;
}

/**
 * The files on the rows the selections span, or on the cursor's row when nothing is selected. A
 * selection ending at the start of a line has not taken that line in.
 */
function selectedFiles(page: Page, selections: readonly vscode.Selection[]): ChangedFile[] {
  const rows = new Set<number>();
  for (const { start, end } of selections) {
    const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    for (let row = start.line; row <= last; row++) {
      rows.add(row);
    }
  }
  return [...rows]
    .sort((a, b) => a - b)
    .flatMap((row) => {
      const target = page.lines[row]?.target;
      return target?.kind === "WorkspaceDiff" ? [target.file] : [];
    });
}

async function commitSelected(cabaret: Cabaret, provider: PageProvider, change: ChangeId): Promise<string> {
  const editor = activePage();
  const page = editor === undefined ? undefined : provider.page(editor.document.uri);
  const files = editor === undefined || page === undefined ? [] : selectedFiles(page, editor.selections);
  if (files.length === 0) {
    throw new Error("no file is selected");
  }
  await cabaret.commit(change, files);
  return `committed ${words(files.map((file) => file.path))} to ${change}`;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, provider),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, new BlobProvider()),
    vscode.workspace.registerFileSystemProvider(DESCRIPTION_SCHEME, new DescriptionProvider(provider), {
      isCaseSensitive: true,
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        provider.decorate(editor);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [session, open] of sessionTerminals) {
        if (open === terminal) {
          sessionTerminals.delete(session);
        }
      }
    }),
    // A page that grew a tail needs its new lines painted too.
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.uri.scheme === SCHEME) {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === document) {
            provider.decorate(editor);
          }
        }
      }
    }),
    // A switch updates the active editor and the tab model separately, so recompute on either.
    vscode.window.onDidChangeActiveTextEditor(updatePageContext),
    vscode.window.tabGroups.onDidChangeTabs(updatePageContext),
    command("cabaret.home", async () => {
      await provider.open({ kind: "home" });
    }),
    onChange("cabaret.showChange", provider, (_, change) => provider.open({ kind: "show", change })),
    onChange("cabaret.diff", provider, (_, change) => provider.open({ kind: "diff", change })),
    onChange("cabaret.editTitle", provider, (cabaret, change) => editTitle(cabaret, provider, change)),
    onChange("cabaret.editDescription", provider, (_, change) => editDescription(change)),
    command("cabaret.workspaceDiff", (cabaret) => openPage(cabaret, provider, "workspace")),
    // Enter: follow whatever the cursor is on; on a file diff, into the file itself.
    command("cabaret.stepIn", async (cabaret) => {
      const fileDiff = activeFileDiff();
      if (fileDiff !== undefined) {
        await enterFile(context, cabaret, fileDiff);
        return;
      }
      const editor = activePage();
      const target = editor === undefined ? undefined : provider.targetUnderCursor(editor);
      if (target !== undefined) {
        await follow(cabaret, provider, target);
      }
    }),
    // Escape: out one scope, a file diff into the view it came from.
    command("cabaret.stepOut", async () => {
      const fileDiff = activeFileDiff();
      if (fileDiff !== undefined) {
        await provider.open({ kind: fileDiff.view, change: fileDiff.change });
        return;
      }
      const editor = activePage();
      const out = editor === undefined ? undefined : enclosing(parseRoute(editor.document.uri));
      if (out !== undefined) {
        await provider.open(out);
      }
    }),
    command("cabaret.refresh", () => refresh(provider)),
    command("cabaret.stepUp", (cabaret) => step(cabaret, provider, "up")),
    command("cabaret.stepDown", (cabaret) => step(cabaret, provider, "down")),
    action("cabaret.createChild", provider, createChild, parentForNewChange),
    action("cabaret.createParent", provider, createParent),
    action("cabaret.addOwner", provider, addOwner),
    action("cabaret.removeOwner", provider, removeOwner),
    action("cabaret.addParent", provider, addParent),
    action("cabaret.removeParent", provider, removeParent),
    action("cabaret.land", provider, land),
    action("cabaret.rebase", provider, rebase),
    action("cabaret.toggleArchived", provider, toggleArchived),
    action("cabaret.commitAll", provider, commitAll),
    action("cabaret.commitSelected", provider, (cabaret, change) => commitSelected(cabaret, provider, change)),
    action("cabaret.startSession", provider, startSession),
    action("cabaret.addWorkspace", provider, async (cabaret, change) => {
      return `added a workspace for ${change} at ${await cabaret.workspaceAdd(change)}`;
    }),
    action("cabaret.removeWorkspace", provider, async (cabaret, change) => {
      await cabaret.workspaceRemove(change);
      return `removed the workspace holding ${change}`;
    }),
    command("cabaret.gotoWorkspace", (cabaret) => gotoWorkspace(context, cabaret, provider)),
  );
  updatePageContext();
  // Leaderkey scans `leaderkey.overrides.*` contributions when it activates, which can precede
  // this extension registering its own; a rescan picks the bindings up either way.
  if (vscode.extensions.getExtension("JimmyZJX.leaderkey") !== undefined) {
    void vscode.commands.executeCommand("leaderkey.refreshConfigs").then(undefined, () => undefined);
  }
  void reporting(() => takeHandoff(context, provider));
}

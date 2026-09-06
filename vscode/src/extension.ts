import {
  Cabaret,
  type ChangedFile,
  type ChangeId,
  type Page,
  type RepoPath,
  type Revision,
  type Segment,
  type Tag,
  type Target,
} from "@cabaret/node";
import * as vscode from "vscode";

const SCHEME = "cabaret";
const BLOB_SCHEME = "cabaret-blob";

let session: { dir: string; cabaret: Cabaret } | undefined;

function openCabaret(): Cabaret {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (dir === undefined) {
    throw new Error("no workspace folder open");
  }
  if (session?.dir !== dir) {
    session = { dir, cabaret: new Cabaret(dir) };
  }
  return session.cabaret;
}

type Route = { kind: "home" } | { kind: "show" | "diff"; change: ChangeId };

function routeUri(route: Route): vscode.Uri {
  const path = route.kind === "home" ? "/home" : `/${route.kind}/${route.change}`;
  return vscode.Uri.from({ scheme: SCHEME, path });
}

function parseRoute(uri: vscode.Uri): Route {
  if (uri.path === "/home") {
    return { kind: "home" };
  }
  const [, kind, change] = /^\/(show|diff)\/(.+)$/.exec(uri.path) ?? [];
  if ((kind !== "show" && kind !== "diff") || change === undefined) {
    throw new Error(`unknown page ${uri.toString()}`);
  }
  return { kind, change };
}

function renderRoute(cabaret: Cabaret, route: Route): Promise<Page> {
  switch (route.kind) {
    case "home":
      return cabaret.homePage();
    case "show":
      return cabaret.showPage(route.change);
    case "diff":
      return cabaret.diffPage(route.change);
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

/** Serves `cabaret:` pages and paints their tags onto whichever editors show them. */
class PageProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.FoldingRangeProvider
{
  private readonly pages = new Map<string, Page>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly decorations = Object.fromEntries(
    TAGS.map((tag) => [tag, vscode.window.createTextEditorDecorationType(STYLES[tag])]),
  ) as Record<Tag, vscode.TextEditorDecorationType>;
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const page = await renderRoute(openCabaret(), parseRoute(uri));
    this.pages.set(uri.toString(), page);
    return pageText(page);
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

  /** Re-render `route` from the repository and show it. */
  async open(route: Route): Promise<void> {
    const uri = routeUri(route);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    this.decorate(await vscode.window.showTextDocument(document, { preview: false }));
  }
}

/**
 * `cabaret-blob:/<path>?change=<id>&revision=<rev>`: the file's text at that revision, or empty
 * with no revision, as one side of a file diff in `change`.
 */
function blobUri(change: ChangeId, revision: Revision | undefined, path: RepoPath): vscode.Uri {
  const query = new URLSearchParams({ change });
  if (revision !== undefined) {
    query.set("revision", revision);
  }
  return vscode.Uri.from({ scheme: BLOB_SCHEME, path: `/${path}`, query: query.toString() });
}

class BlobProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const revision = new URLSearchParams(uri.query).get("revision");
    return revision === null ? "" : ((await openCabaret().blob(revision, uri.path.slice(1))) ?? "");
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

async function openDiff(cabaret: Cabaret, change: ChangeId, file: ChangedFile): Promise<void> {
  const before = blobUri(change, await beforeRevision(cabaret, change, file), "from" in file ? file.from : file.path);
  const after = blobUri(change, file.kind === "Deleted" ? undefined : (await cabaret.change(change)).tip, file.path);
  await vscode.commands.executeCommand("vscode.diff", before, after, `${file.path} (${change})`);
}

async function follow(cabaret: Cabaret, provider: PageProvider, target: Target): Promise<void> {
  switch (target.kind) {
    case "Change":
      await provider.open({ kind: "show", change: target.change });
      break;
    case "Diff":
      await openDiff(cabaret, target.change, target.file);
      break;
  }
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

type FileDiff = { change: ChangeId; path: RepoPath };

/** The blob-backed diff the active tab shows, if it is one. */
function activeBlobDiff(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff && input.modified.scheme === BLOB_SCHEME ? input : undefined;
}

/** The file diff the active tab shows, if it is one; its modified side is always at the file's own path. */
function activeFileDiff(): FileDiff | undefined {
  const input = activeBlobDiff();
  if (input === undefined) {
    return undefined;
  }
  const change = new URLSearchParams(input.modified.query).get("change");
  if (change === null) {
    throw new Error(`${input.modified.toString()} names no change`);
  }
  return { change, path: input.modified.path.slice(1) };
}

type PageKind = Route["kind"] | "file";

/** Expose the active page's kind as the `cabaret.page` context, so keybindings can scope to pages. */
function updatePageContext(): void {
  const editor = activePage();
  const kind: PageKind | undefined =
    activeBlobDiff() !== undefined ? "file" : editor === undefined ? undefined : parseRoute(editor.document.uri).kind;
  vscode.commands.executeCommand("setContext", "cabaret.page", kind);
}

/** The scope enclosing a page: a change's diff sits in its show page, which sits in home. */
function enclosing(route: Route): Route | undefined {
  switch (route.kind) {
    case "home":
      return undefined;
    case "show":
      return { kind: "home" };
    case "diff":
      return { kind: "show", change: route.change };
  }
}

/** The change the active file diff or page is about, else the one checked out in the workspace. */
async function activeChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId> {
  const editor = activePage();
  return (
    activeFileDiff()?.change ??
    (editor === undefined ? undefined : pageChange(provider, editor)) ??
    cabaret.currentChange()
  );
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

/** On a file diff, `^`/`$` go to the file above or below it in the change's diff. */
async function stepFile(cabaret: Cabaret, { change, path }: FileDiff, direction: Direction): Promise<void> {
  const files = await cabaret.changedFiles(change);
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
  await openDiff(cabaret, change, file);
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
 * The page `! w g` leaves for the window it opens on a workspace, in global state since a new
 * window starts its own extension host. Dated, as the window never starts when the folder is
 * already open elsewhere, and a handoff must not surprise a later start.
 */
type Handoff = { route: Route; at: number };

const HANDOFF_TTL = 60_000;

const handoffKey = (dir: string): string => `handoff:${dir}`;

async function gotoWorkspace(
  context: vscode.ExtensionContext,
  cabaret: Cabaret,
  provider: PageProvider,
): Promise<void> {
  const path = await cabaret.workspacePath(await activeChange(cabaret, provider));
  const editor = activePage();
  if (editor !== undefined) {
    const handoff: Handoff = { route: parseRoute(editor.document.uri), at: Date.now() };
    await context.globalState.update(handoffKey(path), handoff);
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), { forceNewWindow: true });
}

/** On startup, open the page a `! w g` elsewhere left for this window's workspace. */
async function takeHandoff(context: vscode.ExtensionContext, provider: PageProvider): Promise<void> {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (dir === undefined) {
    return;
  }
  const handoff = context.globalState.get<Handoff>(handoffKey(dir));
  if (handoff === undefined) {
    return;
  }
  await context.globalState.update(handoffKey(dir), undefined);
  if (Date.now() - handoff.at < HANDOFF_TTL) {
    await provider.open(handoff.route);
  }
}

/** Re-render the active page from the repository. */
async function refresh(provider: PageProvider): Promise<void> {
  const editor = activePage();
  if (editor !== undefined) {
    await provider.open(parseRoute(editor.document.uri));
  }
}

/**
 * `!` then a key: `run` acts on the change the active page is about and says what it did; the
 * page is then re-rendered to show the result.
 */
function action(
  name: string,
  provider: PageProvider,
  run: (cabaret: Cabaret, change: ChangeId) => Promise<string>,
): vscode.Disposable {
  return command(name, async (cabaret) => {
    const report = await run(cabaret, await activeChange(cabaret, provider));
    vscode.window.showInformationMessage(`Cabaret: ${report}`);
    await refresh(provider);
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

async function toggleArchived(cabaret: Cabaret, change: ChangeId): Promise<string> {
  return `${(await cabaret.toggleArchived(change)) ? "archived" : "unarchived"} ${change}`;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, provider),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, new BlobProvider()),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        provider.decorate(editor);
      }
    }),
    // A switch updates the active editor and the tab model separately, so recompute on either.
    vscode.window.onDidChangeActiveTextEditor(updatePageContext),
    vscode.window.tabGroups.onDidChangeTabs(updatePageContext),
    command("cabaret.home", async () => {
      await provider.open({ kind: "home" });
    }),
    command("cabaret.showChange", async (cabaret) => {
      const change = await pickChange(cabaret, "Cabaret: Show Change");
      if (change !== undefined) {
        await provider.open({ kind: "show", change });
      }
    }),
    command("cabaret.diff", async (cabaret) => {
      await provider.open({ kind: "diff", change: await activeChange(cabaret, provider) });
    }),
    // Enter: follow whatever the cursor is on.
    command("cabaret.stepIn", async (cabaret) => {
      const editor = activePage();
      const target = editor === undefined ? undefined : provider.targetUnderCursor(editor);
      if (target !== undefined) {
        await follow(cabaret, provider, target);
      }
    }),
    // Escape: out one scope, a file diff into its change's diff.
    command("cabaret.stepOut", async () => {
      const fileDiff = activeFileDiff();
      if (fileDiff !== undefined) {
        await provider.open({ kind: "diff", change: fileDiff.change });
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
    action("cabaret.land", provider, async (cabaret, change) => `landed ${change} into ${await cabaret.land(change)}`),
    action("cabaret.rebase", provider, rebase),
    action("cabaret.toggleArchived", provider, toggleArchived),
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

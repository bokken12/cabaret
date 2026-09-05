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

/** `cabaret-blob:/<path>?<revision>`: the file's text at that revision, or empty with no revision. */
function blobUri(revision: Revision | undefined, path: RepoPath): vscode.Uri {
  return vscode.Uri.from({ scheme: BLOB_SCHEME, path: `/${path}`, query: revision ?? "" });
}

class BlobProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return uri.query === "" ? "" : ((await openCabaret().blob(uri.query, uri.path.slice(1))) ?? "");
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
  const before = blobUri(await beforeRevision(cabaret, change, file), "from" in file ? file.from : file.path);
  const after = blobUri(file.kind === "Deleted" ? undefined : (await cabaret.change(change)).tip, file.path);
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

/** The change the active page is about, else the one checked out in the workspace. */
async function activeChange(cabaret: Cabaret, provider: PageProvider): Promise<ChangeId> {
  const editor = activePage();
  return (editor === undefined ? undefined : pageChange(provider, editor)) ?? cabaret.currentChange();
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

/**
 * Step from the change the active page is about to one of its parents or children: on the home
 * page by moving the cursor onto its row, or opening it when it is not drawn there; on a change's
 * page by opening the same kind of page for it.
 */
async function step(cabaret: Cabaret, provider: PageProvider, relation: "parents" | "children"): Promise<void> {
  const editor = activePage();
  if (editor === undefined) {
    return;
  }
  const from = pageChange(provider, editor);
  if (from === undefined) {
    return;
  }
  const candidates = [
    ...(relation === "parents" ? (await cabaret.change(from)).parents : await cabaret.children(from)),
  ];
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

function command(name: string, run: (cabaret: Cabaret) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, async () => {
    try {
      await run(openCabaret());
    } catch (error) {
      vscode.window.showErrorMessage(`Cabaret: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
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
    // Escape: from any change's page back home.
    command("cabaret.stepOut", async () => {
      const editor = activePage();
      if (editor !== undefined && parseRoute(editor.document.uri).kind !== "home") {
        await provider.open({ kind: "home" });
      }
    }),
    command("cabaret.stepUp", (cabaret) => step(cabaret, provider, "parents")),
    command("cabaret.stepDown", (cabaret) => step(cabaret, provider, "children")),
  );
}

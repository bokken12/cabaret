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

function renderRoute(cabaret: Cabaret, route: Route): Page {
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

  provideTextDocumentContent(uri: vscode.Uri): string {
    const page = renderRoute(openCabaret(), parseRoute(uri));
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
  provideTextDocumentContent(uri: vscode.Uri): string {
    return uri.query === "" ? "" : (openCabaret().blob(uri.query, uri.path.slice(1)) ?? "");
  }
}

function beforeRevision(cabaret: Cabaret, change: ChangeId, file: ChangedFile): Revision | undefined {
  if (file.kind === "Added") {
    return undefined;
  }
  const base = cabaret.base(change);
  if (base === null) {
    throw new Error(`${change} has no base, yet ${file.path} was not added`);
  }
  return base;
}

async function openDiff(cabaret: Cabaret, change: ChangeId, file: ChangedFile): Promise<void> {
  const before = blobUri(beforeRevision(cabaret, change, file), "from" in file ? file.from : file.path);
  const after = blobUri(file.kind === "Deleted" ? undefined : cabaret.change(change).tip, file.path);
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

/**
 * The change the active page views, on the home page the one under the cursor, else the one
 * checked out in the workspace.
 */
function activeChange(cabaret: Cabaret, provider: PageProvider): ChangeId {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== SCHEME) {
    return cabaret.currentChange();
  }
  const route = parseRoute(editor.document.uri);
  if (route.kind !== "home") {
    return route.change;
  }
  const page = provider.page(editor.document.uri);
  const target = page === undefined ? undefined : targetAt(page, editor.selection.active);
  return target?.kind === "Change" ? target.change : cabaret.currentChange();
}

async function pickChange(cabaret: Cabaret, title: string): Promise<ChangeId | undefined> {
  const current = cabaret.currentChange();
  const items = cabaret.changes().map((change) => ({
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
      await provider.open({ kind: "diff", change: activeChange(cabaret, provider) });
    }),
    // Enter on a page: follow whatever the cursor is on.
    command("cabaret.open", async (cabaret) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        return;
      }
      const page = provider.page(editor.document.uri);
      const target = page === undefined ? undefined : targetAt(page, editor.selection.active);
      if (target !== undefined) {
        await follow(cabaret, provider, target);
      }
    }),
  );
}

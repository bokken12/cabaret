import {
  Cabaret,
  type ChangedFile,
  type ChangeId,
  type ChangeSnapshot,
  type RepoPath,
  type Revision,
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

function renderChange(id: ChangeId, change: ChangeSnapshot): string {
  const sections = [change.title === undefined ? `# ${id}` : `# ${id} — ${change.title}`];
  if (change.description !== undefined) {
    sections.push(change.description);
  }
  sections.push(
    [
      `- **Owners:** ${[...change.owners].join(", ") || "(none)"}`,
      `- **Parents:** ${[...change.parents].join(", ") || "(none)"}`,
    ].join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

function renderFile(file: ChangedFile): string {
  switch (file.kind) {
    case "Added":
    case "Deleted":
    case "Modified":
      return file.path;
    case "Renamed":
      return `${file.from} -> ${file.path}`;
    case "Copied":
      return `${file.from} => ${file.path}`;
  }
}

/** One file per line, so line `i` is `files[i]`. */
function renderFiles(files: ChangedFile[]): string {
  return files.length === 0 ? "no changed files\n" : `${files.map(renderFile).join("\n")}\n`;
}

const PAGE_KINDS = ["show", "diff"] as const;
type PageKind = (typeof PAGE_KINDS)[number];
type Page = { kind: PageKind; change: ChangeId };

const PAGE_LANGUAGES: Record<PageKind, string> = { show: "markdown", diff: "plaintext" };

function pageUri(page: Page): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${page.kind}/${page.change}` });
}

function parsePage(uri: vscode.Uri): Page {
  const [, kind, change] = /^\/([^/]+)\/(.+)$/.exec(uri.path) ?? [];
  const known = PAGE_KINDS.find((known) => known === kind);
  if (known === undefined || change === undefined) {
    throw new Error(`unknown page ${uri.toString()}`);
  }
  return { kind: known, change };
}

/** Serves `cabaret:` pages, remembering each diff page's files so Enter hits what is on screen. */
class PageProvider implements vscode.TextDocumentContentProvider {
  private readonly files = new Map<string, ChangedFile[]>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const page = parsePage(uri);
    const cabaret = openCabaret();
    switch (page.kind) {
      case "show":
        return renderChange(page.change, cabaret.change(page.change));
      case "diff": {
        const files = cabaret.changedFiles(page.change);
        this.files.set(uri.toString(), files);
        return renderFiles(files);
      }
    }
  }

  fileAt(uri: vscode.Uri, line: number): ChangedFile | undefined {
    return this.files.get(uri.toString())?.[line];
  }

  /** Re-render `page` from the repository and show it. */
  async open(page: Page): Promise<void> {
    const uri = pageUri(page);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, PAGE_LANGUAGES[page.kind]);
    await vscode.window.showTextDocument(document, { preview: false });
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
  await vscode.commands.executeCommand("vscode.diff", before, after, `${renderFile(file)} (${change})`);
}

/** The change the active page views, else the one checked out in the workspace. */
function activeChange(cabaret: Cabaret): ChangeId {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === SCHEME ? parsePage(uri).change : cabaret.currentChange();
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
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, new BlobProvider()),
    command("cabaret.showChange", async (cabaret) => {
      const change = await pickChange(cabaret, "Cabaret: Show Change");
      if (change !== undefined) {
        await provider.open({ kind: "show", change });
      }
    }),
    command("cabaret.diff", async (cabaret) => {
      await provider.open({ kind: "diff", change: activeChange(cabaret) });
    }),
    // Enter on a diff page row: the file's before/after in the built-in diff editor.
    command("cabaret.open", async (cabaret) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        return;
      }
      const file = provider.fileAt(editor.document.uri, editor.selection.active.line);
      if (file !== undefined) {
        await openDiff(cabaret, parsePage(editor.document.uri).change, file);
      }
    }),
  );
}

import { Cabaret, type ChangedFile, type ChangeId, type ChangeSnapshot } from "@cabaret/node";
import * as vscode from "vscode";

const SCHEME = "cabaret";

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

function renderFiles(files: ChangedFile[]): string {
  return files.length === 0 ? "no changed files\n" : `${files.map(renderFile).join("\n")}\n`;
}

/** Each `cabaret:/<kind>/<change>` page, and its language for highlighting. */
const pages = {
  show: { language: "markdown", render: (cabaret, change) => renderChange(change, cabaret.change(change)) },
  diff: { language: "plaintext", render: (cabaret, change) => renderFiles(cabaret.changedFiles(change)) },
} satisfies Record<string, { language: string; render: (cabaret: Cabaret, change: ChangeId) => string }>;

type PageKind = keyof typeof pages;
type Page = { kind: PageKind; change: ChangeId };

function pageUri(page: Page): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${page.kind}/${page.change}` });
}

function parsePage(uri: vscode.Uri): Page {
  const [, kind, change] = /^\/([^/]+)\/(.+)$/.exec(uri.path) ?? [];
  if (kind === undefined || !Object.hasOwn(pages, kind) || change === undefined) {
    throw new Error(`unknown page ${uri.toString()}`);
  }
  return { kind: kind as PageKind, change };
}

class PageProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const page = parsePage(uri);
    return pages[page.kind].render(openCabaret(), page.change);
  }

  /** Re-render `page` from the repository and show it. */
  async open(page: Page): Promise<void> {
    const uri = pageUri(page);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, pages[page.kind].language);
    await vscode.window.showTextDocument(document, { preview: false });
  }
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
    command("cabaret.showChange", async (cabaret) => {
      const change = await pickChange(cabaret, "Cabaret: Show Change");
      if (change !== undefined) {
        await provider.open({ kind: "show", change });
      }
    }),
    command("cabaret.diff", async (cabaret) => {
      await provider.open({ kind: "diff", change: activeChange(cabaret) });
    }),
  );
}

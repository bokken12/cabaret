import * as vscode from "vscode";

import { Cabaret, type Change, type Fold, type HomeRow } from "@cabaret/node";

const SCHEME = "cabaret";
const HOME_URI = vscode.Uri.from({ scheme: SCHEME, path: "/home" });

function showUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/show/${id}` });
}

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

function command(name: string, run: (cabaret: Cabaret, ...args: unknown[]) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, async (...args: unknown[]) => {
    try {
      await run(openCabaret(), ...args);
    } catch (error) {
      vscode.window.showErrorMessage(`Cabaret: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function pickChange(cabaret: Cabaret, title: string): Promise<string | undefined> {
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

function renderChange(id: string, info: Change): string {
  const sections = [info.title === undefined ? `# ${id}` : `# ${id} — ${info.title}`];
  if (info.description !== undefined) {
    sections.push(info.description);
  }
  sections.push(
    [
      `- **Owners:** ${[...info.owners].join(", ") || "(none)"}`,
      `- **Parents:** ${[...info.parents].join(", ") || "(none)"}`,
    ].join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

/**
 * Serves `cabaret:` pages, remembering the home render's rows and folds so
 * links, Enter, and folding hit-test exactly what is on screen.
 */
class PageProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.FoldingRangeProvider
{
  private homeRows: readonly HomeRow[] = [];
  private homeFolds: readonly Fold[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const cabaret = openCabaret();
    if (uri.path === HOME_URI.path) {
      const home = cabaret.home();
      this.homeRows = home.rows;
      this.homeFolds = home.folds;
      return home.text || "no open changes\n";
    }
    const id = /^\/show\/(.+)$/.exec(uri.path)?.[1];
    if (id === undefined) {
      throw new Error(`unknown page ${uri.toString()}`);
    }
    return renderChange(id, cabaret.change(id));
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] | undefined {
    if (document.uri.path !== HOME_URI.path) {
      return undefined;
    }
    return this.homeRows.map((row, line) => {
      const args = encodeURIComponent(JSON.stringify([row.change]));
      const link = new vscode.DocumentLink(
        new vscode.Range(line, row.labelStart, line, row.labelStart + row.change.length),
        vscode.Uri.parse(`command:cabaret.openTarget?${args}`, true),
      );
      link.tooltip = `Show ${row.change}`;
      return link;
    });
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] | undefined {
    if (document.uri.path !== HOME_URI.path) {
      return undefined;
    }
    return this.homeFolds.map((fold) => new vscode.FoldingRange(fold.start, fold.end));
  }

  changeAt(line: number): string | undefined {
    return this.homeRows[line]?.change;
  }

  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }
}

async function openPage(provider: PageProvider, uri: vscode.Uri, language?: string): Promise<void> {
  provider.refresh(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (language !== undefined) {
    await vscode.languages.setTextDocumentLanguage(document, language);
  }
  await vscode.window.showTextDocument(document, { preview: false });
}

/** The change under the cursor when the active editor is the home page. */
function changeAtCursor(provider: PageProvider): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.toString() !== HOME_URI.toString()) {
    return undefined;
  }
  return provider.changeAt(editor.selection.active.line);
}

/**
 * The change the editor focus points at: the home row under the cursor, the change a show page
 * views, or the change held by the worktree containing the active file.
 */
function activeChange(provider: PageProvider): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri === undefined) {
    return undefined;
  }
  if (uri.scheme === SCHEME) {
    return uri.path === HOME_URI.path ? changeAtCursor(provider) : /^\/show\/(.+)$/.exec(uri.path)?.[1];
  }
  if (uri.scheme === "file") {
    return new Cabaret(vscode.Uri.joinPath(uri, "..").fsPath).currentChange();
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
    vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, provider),
    command("cabaret.home", async () => {
      await openPage(provider, HOME_URI);
    }),
    command("cabaret.showChanges", async (cabaret) => {
      await pickChange(cabaret, "Cabaret Changes");
    }),
    command("cabaret.showChange", async (cabaret) => {
      const id = await pickChange(cabaret, "Cabaret: Show Change");
      if (id !== undefined) {
        await openPage(provider, showUri(id), "markdown");
      }
    }),
    command("cabaret.rebase", async (cabaret) => {
      const change = activeChange(provider);
      if (change === undefined) {
        throw new Error("no active change to rebase");
      }
      const parents = [...cabaret.change(change).parents];
      if (parents.length === 0) {
        throw new Error(`${change} has no parents`);
      }
      const onto =
        parents.length === 1
          ? parents[0]
          : await vscode.window.showQuickPick(parents, { title: `Rebase ${change} onto` });
      if (onto === undefined) {
        return;
      }
      const conflicts = cabaret.rebase(change, onto);
      provider.refresh(HOME_URI);
      if (conflicts === null) {
        vscode.window.showInformationMessage(`${change} is already up to date`);
      } else if (conflicts.length > 0) {
        vscode.window.showWarningMessage(`rebased ${change} onto ${onto}; conflicted: ${conflicts.join(", ")}`);
      } else {
        vscode.window.showInformationMessage(`rebased ${change} onto ${onto}`);
      }
    }),
    // Enter on a home row, or a click on its id label (which passes the id).
    command("cabaret.openTarget", async (_cabaret, id) => {
      const target = typeof id === "string" ? id : changeAtCursor(provider);
      if (target !== undefined) {
        await openPage(provider, showUri(target), "markdown");
      }
    }),
  );
}

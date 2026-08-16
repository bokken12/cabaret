import * as vscode from "vscode";

import { Cabaret, type Change, type HomeRow } from "@cabaret/node";

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
 * Serves `cabaret:` pages, remembering the home render's rows so links and
 * Enter hit-test exactly what is on screen.
 */
class PageProvider implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider {
  private homeRows: readonly HomeRow[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const cabaret = openCabaret();
    if (uri.path === HOME_URI.path) {
      const home = cabaret.home();
      this.homeRows = home.rows;
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

export function activate(context: vscode.ExtensionContext) {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, provider),
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
    // Enter on a home row, or a click on its id label (which passes the id).
    command("cabaret.openTarget", async (_cabaret, id) => {
      const target = typeof id === "string" ? id : changeAtCursor(provider);
      if (target !== undefined) {
        await openPage(provider, showUri(target), "markdown");
      }
    }),
  );
}

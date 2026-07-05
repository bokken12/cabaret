import { type Backend, parseRefName } from "cabaret-core";
import { GitBackend } from "cabaret-node";
import { type Doc, docText, targetAt } from "cabaret-views";
import * as vscode from "vscode";
import { type Page, pagePath, parsePagePath } from "./pages.js";
import { renderPage } from "./render.js";
import { styledRanges, TOKEN_TYPES } from "./tokens.js";

const SCHEME = "cabaret";

/** Open the backend for the repository containing the first workspace folder. */
async function openBackend(): Promise<Backend> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error("cabaret needs an open folder inside a git repository");
  }
  return GitBackend.open(folder.uri.fsPath);
}

/**
 * Serves `cabaret:` documents, remembering each page's doc so cursor
 * positions hit-test against exactly what is on screen.
 */
class PageProvider implements vscode.TextDocumentContentProvider, vscode.DocumentSemanticTokensProvider {
  private readonly docs = new Map<string, Doc>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  readonly legend = new vscode.SemanticTokensLegend([...TOKEN_TYPES]);

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Renders can overlap a close or one another, briefly caching a doc out
    // of step with the buffer; the next render resolves it, so no guard.
    const doc = await renderPage(await openBackend(), parsePagePath(uri.path));
    this.docs.set(uri.toString(), doc);
    return docText(doc);
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(this.legend);
    for (const { line, start, length, style } of styledRanges(this.renderedDoc(document.uri) ?? { lines: [] })) {
      builder.push(new vscode.Range(line, start, line, start + length), style);
    }
    return builder.build();
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

  forget(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }
}

async function openPage(provider: PageProvider, page: Page): Promise<void> {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: pagePath(page) });
  // Reopening an already-open page serves the buffer as it stands, so ask for
  // a fresh render alongside.
  if (provider.doc(uri) !== undefined) {
    provider.refresh(uri);
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function showChange(provider: PageProvider): Promise<void> {
  const backend = await openBackend();
  const change = await vscode.window.showQuickPick(await backend.listChanges(), { placeHolder: "Change to show" });
  if (change !== undefined) {
    await openPage(provider, { kind: "show", change: parseRefName(change) });
  }
}

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
  switch (target.kind) {
    case "change":
      await openPage(provider, { kind: "show", change: target.change });
      break;
    case "file":
      // TODO: route file targets to the diff page once it exists.
      vscode.window.showInformationMessage(`cabaret: no diff view yet for ${target.file}`);
      break;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PageProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDocumentSemanticTokensProvider({ scheme: SCHEME }, provider, provider.legend),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SCHEME) {
        provider.forget(document.uri);
      }
    }),
    vscode.commands.registerCommand("cabaret.todo", () => openPage(provider, { kind: "todo" })),
    vscode.commands.registerCommand("cabaret.show", () => showChange(provider)),
    vscode.commands.registerCommand("cabaret.openTarget", () => openTarget(provider)),
    vscode.commands.registerCommand("cabaret.refresh", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri !== undefined && uri.scheme === SCHEME) {
        provider.refresh(uri);
      }
    }),
  );
}

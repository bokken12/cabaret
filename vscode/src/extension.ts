import * as vscode from "vscode";

import { type Change, change, changes, currentChange } from "@cabaret/node";

function command(name: string, run: (dir: string) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, async () => {
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (dir === undefined) {
      vscode.window.showErrorMessage("Cabaret: no workspace folder open");
      return;
    }
    try {
      await run(dir);
    } catch (error) {
      vscode.window.showErrorMessage(`Cabaret: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function pickChange(dir: string, title: string): Promise<string | undefined> {
  const current = currentChange(dir);
  const items = changes(dir).map((change) => ({
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

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    command("cabaret.showChanges", async (dir) => {
      await pickChange(dir, "Cabaret Changes");
    }),
    command("cabaret.showChange", async (dir) => {
      const id = await pickChange(dir, "Cabaret: Show Change");
      if (id === undefined) {
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: renderChange(id, change(dir, id)),
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );
}

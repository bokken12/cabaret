import * as vscode from "vscode";

import { Cabaret, type Change } from "@cabaret/node";

let session: { dir: string; cabaret: Cabaret } | undefined;

function command(name: string, run: (cabaret: Cabaret) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, async () => {
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (dir === undefined) {
      vscode.window.showErrorMessage("Cabaret: no workspace folder open");
      return;
    }
    try {
      if (session?.dir !== dir) {
        session = { dir, cabaret: new Cabaret(dir) };
      }
      await run(session.cabaret);
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

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    command("cabaret.showChanges", async (cabaret) => {
      await pickChange(cabaret, "Cabaret Changes");
    }),
    command("cabaret.showChange", async (cabaret) => {
      const id = await pickChange(cabaret, "Cabaret: Show Change");
      if (id === undefined) {
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: renderChange(id, cabaret.change(id)),
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );
}

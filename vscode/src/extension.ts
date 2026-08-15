import * as vscode from "vscode";

import { changes, currentChange } from "@cabaret/node";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("cabaret.showChanges", async () => {
      const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (dir === undefined) {
        vscode.window.showErrorMessage("Cabaret: no workspace folder open");
        return;
      }
      try {
        const current = currentChange(dir);
        const items = changes(dir).map((change) => ({
          label: change,
          description: change === current ? "current" : undefined,
        }));
        await vscode.window.showQuickPick(items, {
          title: "Cabaret Changes",
          placeHolder: items.length === 0 ? "no changes" : undefined,
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Cabaret: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

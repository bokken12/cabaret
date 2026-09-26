import * as assert from "node:assert/strict";
import * as vscode from "vscode";

/** Every tab, the active one marked, then the cursor's line in the active editor. */
function screen(): string {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const lines = tabs.map((tab) => `${tab.isActive ? ">" : " "} ${tab.label}`);
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) {
    const { uri } = editor.document;
    const { line } = editor.selection.active;
    // Without the query, which holds revisions that differ from run to run.
    lines.push(`${uri.scheme}:${uri.path}:${line}: ${editor.document.lineAt(line).text}`.trimEnd());
  }
  return lines.map((line) => `  ${line}\n`).join("");
}

/** Put the cursor on the active editor's first occurrence of `text`. */
function cursorTo(text: string): void {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "no active editor");
  const lines = editor.document.getText().split("\n");
  const line = lines.findIndex((candidate) => candidate.includes(text));
  const found = lines[line];
  assert.ok(found !== undefined, `no line contains ${JSON.stringify(text)} in\n${lines.join("\n")}`);
  const position = new vscode.Position(line, found.indexOf(text));
  editor.selection = new vscode.Selection(position, position);
}

/**
 * Commands run one after another, each with the cursor first moved onto some text, and the screen
 * after each, so a whole workflow is compared at once.
 */
async function transcript(steps: [command: string, at?: string][]): Promise<string> {
  let out = "";
  for (const [command, at] of steps) {
    if (at !== undefined) {
      cursorTo(at);
    }
    await vscode.commands.executeCommand(command);
    out += `${command}${at === undefined ? "" : ` at ${JSON.stringify(at)}`}\n${screen()}`;
  }
  return out;
}

// The tests share the fixture of `.vscode-test.mjs`, and run in order.
suite("workflows", () => {
  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("moving between pages and file diffs replaces a single tab", async () => {
    const actual = await transcript([
      ["cabaret.home"],
      ["cabaret.stepIn", "feature"],
      ["cabaret.diff"],
      ["cabaret.stepIn", "a.txt"],
      ["cabaret.stepDown"],
      ["cabaret.stepOut"],
      ["cabaret.stepOut"],
      ["cabaret.stepOut"],
    ]);
    assert.equal(
      actual,
      `cabaret.home
  > review
  cabaret:/home/review:0:  ╭──────────┬─────────┬──────────────╮
cabaret.stepIn at "feature"
  > feature
  cabaret:/show/feature:0: feature
cabaret.diff
  > feature
  cabaret:/diff/feature:6: ├─○ a.txt
cabaret.stepIn at "a.txt"
  > src/a.txt (feature)
  cabaret-blob:/src/a.txt:0: a
cabaret.stepDown
  > src/b.txt (feature)
  cabaret-blob:/src/b.txt:0: b
cabaret.stepOut
  > feature
  cabaret:/diff/feature:6: ├─○ a.txt
cabaret.stepOut
  > feature
  cabaret:/show/feature:0: feature
cabaret.stepOut
  > review
  cabaret:/home/review:4: ○   feature
`,
    );
  });

  test("marking file diffs reviewed moves through review to its emptied page", async () => {
    const actual = await transcript([
      ["cabaret.home"],
      ["cabaret.stepIn", "feature"],
      ["cabaret.review"],
      ["cabaret.stepIn", "a.txt"],
      ["cabaret.mark"],
      ["cabaret.mark"],
    ]);
    assert.equal(
      actual,
      `cabaret.home
  > review
  cabaret:/home/review:4: ○   feature
cabaret.stepIn at "feature"
  > feature
  cabaret:/show/feature:0: feature
cabaret.review
  > feature
  cabaret:/review/feature:6: ├─○ a.txt
cabaret.stepIn at "a.txt"
  > src/a.txt (feature, unreviewed)
  cabaret-blob:/src/a.txt:0: a
cabaret.mark
  > src/b.txt (feature, unreviewed)
  cabaret-blob:/src/b.txt:0: b
cabaret.mark
  > feature
  cabaret:/review/feature:6:
`,
    );
  });
});

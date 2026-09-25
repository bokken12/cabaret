// The `tabInputMultiDiff` proposal (https://github.com/microsoft/vscode/issues/206411): VS Code
// already hands every extension these inputs, only the typings are unpublished.

declare module "vscode" {
  export class TabInputTextMultiDiff {
    readonly textDiffs: TabInputTextDiff[];

    constructor(textDiffs: TabInputTextDiff[]);
  }

  export interface Tab {
    readonly input:
      | TabInputText
      | TabInputTextDiff
      | TabInputTextMultiDiff
      | TabInputCustom
      | TabInputWebview
      | TabInputNotebook
      | TabInputNotebookDiff
      | TabInputTerminal
      | unknown;
  }
}

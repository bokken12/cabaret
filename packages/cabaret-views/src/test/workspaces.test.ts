import { parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { displayPath, docText, targetAt, type WorkspaceRow, workspacesDoc } from "../index.js";

test("displayPath reads nearby paths relative to the current workspace, distant ones absolute", () => {
  expect(displayPath("/src/widgets", "/src/widgets")).toBe(".");
  expect(displayPath("/src/widgets", "/src/widgets/vendor")).toBe("vendor");
  expect(displayPath("/src/widgets", "/src/widgets-gadget")).toBe("../widgets-gadget");
  expect(displayPath("/src/widgets", "/src")).toBe("..");
  expect(displayPath("/src/nested/widgets", "/src/homes/gadget")).toBe("../../homes/gadget");
  expect(displayPath("/src/very/nested/widgets", "/scratch/gadget")).toBe("/scratch/gadget");
});

test("workspacesDoc lays out each workspace with its change and notes", () => {
  const row = (
    path: string,
    display: string,
    branch: string | undefined,
    opts?: Partial<Omit<WorkspaceRow, "workspace" | "display">> & { dirty?: boolean; primary?: boolean },
  ): WorkspaceRow => ({
    workspace: {
      path,
      branch: branch === undefined ? undefined : parseRefName(branch),
      dirty: opts?.dirty ?? false,
      primary: opts?.primary ?? false,
    },
    display,
    isChange: opts?.isChange ?? false,
    landed: opts?.landed ?? false,
  });
  const doc = workspacesDoc({
    rows: [
      row("/src/widgets", ".", "main", { primary: true }),
      row("/src/widgets-gadget", "../widgets-gadget", "gadget", { isChange: true, dirty: true }),
      row("/src/widgets-relic", "../widgets-relic", "relic", { isChange: true, landed: true }),
      row("/src/widgets-probe", "../widgets-probe", undefined),
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Workspaces
    ==========

    ╭───────────────────┬────────────┬────────╮
    │ workspace         │ change     │ note   │
    ├───────────────────┼────────────┼────────┤
    │ .                 │ main       │        │
    │ ../widgets-gadget │ gadget     │ dirty  │
    │ ../widgets-relic  │ relic      │ landed │
    │ ../widgets-probe  │ (detached) │        │
    ╰───────────────────┴────────────┴────────╯"
  `);
  // Each row resolves to its workspace's directory; a change name links to
  // the change, while a branch that is no change goes nowhere.
  const lines = docText(doc).split("\n");
  const rowLine = (text: string) => lines.findIndex((line) => line.includes(text));
  expect(targetAt(doc, rowLine("main"))).toEqual({ kind: "workspace", path: "/src/widgets" });
  expect(doc.lines[rowLine("gadget")]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target]))).toEqual([
    { kind: "workspace", path: "/src/widgets-gadget" },
    { kind: "change", change: "gadget" },
  ]);
  expect(doc.lines[rowLine("main")]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target]))).toEqual([
    { kind: "workspace", path: "/src/widgets" },
  ]);
});

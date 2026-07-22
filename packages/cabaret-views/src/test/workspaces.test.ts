import { type Dirty, parseBranchName, timestampMs } from "cabaret-core";
import { expect, test } from "vitest";
import { displayPath, docText, targetAt, type WorkspaceRow, workspacesDoc } from "../index.js";

const NOW = timestampMs(Date.UTC(2026, 6, 19, 8, 0, 0));

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
    change: string | undefined,
    opts?: Partial<Omit<WorkspaceRow, "workspace" | "display">> & { dirty?: Dirty; primary?: boolean },
  ): WorkspaceRow => ({
    workspace: {
      path,
      change: change === undefined ? undefined : parseBranchName(change),
      dirty: opts?.dirty,
      primary: opts?.primary ?? false,
    },
    display,
    isChange: opts?.isChange ?? false,
    landed: opts?.landed ?? false,
    archived: opts?.archived ?? false,
  });
  const doc = workspacesDoc(
    {
      rows: [
        row("/src/widgets", ".", "main", { primary: true }),
        row("/src/widgets-gadget", "../widgets-gadget", "gadget", {
          isChange: true,
          dirty: { at: timestampMs(NOW - 5 * 3_600_000) },
        }),
        row("/src/widgets-relic", "../widgets-relic", "relic", { isChange: true, landed: true }),
        row("/src/widgets-shelf", "../widgets-shelf", "shelf", {
          isChange: true,
          dirty: { at: undefined },
          archived: true,
        }),
        row("/src/widgets-probe", "../widgets-probe", undefined),
      ],
    },
    NOW,
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Workspaces
    ==========

    ╭───────────────────┬────────────┬─────────────────╮
    │ workspace         │ change     │ note            │
    ├───────────────────┼────────────┼─────────────────┤
    │ .                 │ main       │                 │
    │ ../widgets-gadget │ gadget     │ dirty 5h        │
    │ ../widgets-relic  │ relic      │ landed          │
    │ ../widgets-shelf  │ shelf      │ dirty, archived │
    │ ../widgets-probe  │ (detached) │                 │
    ╰───────────────────┴────────────┴─────────────────╯"
  `);
  // Each row resolves to its workspace's directory; every named branch links
  // to its page, change or not, while a detached workspace goes nowhere.
  const lines = docText(doc).split("\n");
  const rowLine = (text: string) => lines.findIndex((line) => line.includes(text));
  expect(targetAt(doc, rowLine("main"))).toEqual({ kind: "workspace", path: "/src/widgets" });
  expect(doc.lines[rowLine("gadget")]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target]))).toEqual([
    { kind: "workspace", path: "/src/widgets-gadget" },
    { kind: "change", change: "gadget" },
  ]);
  expect(doc.lines[rowLine("main")]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target]))).toEqual([
    { kind: "workspace", path: "/src/widgets" },
    { kind: "change", change: "main" },
  ]);
  expect(
    doc.lines[rowLine("(detached)")]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target])),
  ).toEqual([{ kind: "workspace", path: "/src/widgets-probe" }]);
});

import { type Backend, landedMerge, type RefName, type Workspace } from "cabaret-core";
import { type Doc, layout, span } from "./doc.js";
import { type Cell, table } from "./table.js";

/**
 * How `path` reads from the workspace at `from`: relative while that stays
 * close — within two steps up — and absolute once relative would read as a
 * trek. Both paths must be absolute, as the backend reports them.
 */
export function displayPath(from: string, path: string): string {
  const here = from.split("/");
  const there = path.split("/");
  let shared = 0;
  while (shared < here.length && shared < there.length && here[shared] === there[shared]) {
    shared += 1;
  }
  const ups = here.length - shared;
  if (ups > 2) {
    return path;
  }
  const relative = [...Array<string>(ups).fill(".."), ...there.slice(shared)].join("/");
  return relative === "" ? "." : relative;
}

/** A change's workspace, as pages note it beside the change. */
export interface WorkspaceNote {
  /** Absolute path of the workspace, for hosts to open. */
  readonly path: string;
  /** The path as read from the current workspace, for display. */
  readonly display: string;
  readonly dirty: boolean;
}

/** Each checked-out branch's workspace note, from the current workspace's point of view. */
export async function workspaceNotes(backend: Backend): Promise<ReadonlyMap<RefName, WorkspaceNote>> {
  const notes = new Map<RefName, WorkspaceNote>();
  for (const { path, branch, dirty } of await backend.workspaces()) {
    if (branch !== undefined) {
      notes.set(branch, { path, display: displayPath(backend.root, path), dirty });
    }
  }
  return notes;
}

/** One workspace on the workspaces page. */
export interface WorkspaceRow {
  readonly workspace: Workspace;
  /** The workspace's path as read from the current workspace. */
  readonly display: string;
  /** Whether the checked-out branch is a change. */
  readonly isChange: boolean;
  /** Whether that change has landed, leaving the workspace ready to remove. */
  readonly landed: boolean;
}

/** What the workspaces page displays: every workspace of the repository. */
export interface WorkspacesPage {
  readonly rows: readonly WorkspaceRow[];
}

export async function workspacesPage(backend: Backend): Promise<WorkspacesPage> {
  const changes = new Set(await backend.listChanges());
  const rows: WorkspaceRow[] = [];
  for (const workspace of await backend.workspaces()) {
    const change = workspace.branch !== undefined && changes.has(workspace.branch) ? workspace.branch : undefined;
    rows.push({
      workspace,
      display: displayPath(backend.root, workspace.path),
      isChange: change !== undefined,
      landed: change !== undefined && landedMerge(await backend.readLog(change)) !== undefined,
    });
  }
  return { rows };
}

export function workspacesDoc(page: WorkspacesPage): Doc {
  const rows = page.rows.map(({ workspace, display, isChange, landed }): readonly Cell[] => {
    const notes = [...(workspace.dirty ? ["dirty"] : []), ...(landed ? ["landed"] : [])];
    const branch =
      workspace.branch === undefined
        ? span("(detached)", { style: "context" })
        : span(workspace.branch, {
            style: isChange ? undefined : "context",
            ...(isChange ? { target: { kind: "change", change: workspace.branch } } : {}),
          });
    return [span(display, { target: { kind: "workspace", path: workspace.path } }), branch, span(notes.join(", "))];
  });
  const title = "Workspaces";
  return layout([
    { spans: [span(title, { style: "heading" })] },
    { spans: [span("=".repeat(title.length))] },
    { spans: [] },
    ...table(
      [
        { header: "workspace", align: "left" },
        { header: "change", align: "left" },
        { header: "note", align: "left" },
      ],
      rows,
    ),
  ]);
}

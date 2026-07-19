import { type Backend, type ChangeName, currentArchived, landedMerge, type Workspace } from "cabaret-core";
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

/** Each checked-out change's workspace note, from the current workspace's point of view. */
export async function workspaceNotes(backend: Backend): Promise<ReadonlyMap<ChangeName, WorkspaceNote>> {
  const notes = new Map<ChangeName, WorkspaceNote>();
  for (const { path, change, dirty } of await backend.workspaces()) {
    if (change !== undefined) {
      notes.set(change, { path, display: displayPath(backend.root, path), dirty });
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
  /** Whether that change is archived, likewise leaving the workspace idle. */
  readonly archived: boolean;
}

/** What the workspaces page displays: every workspace of the repository. */
export interface WorkspacesPage {
  readonly rows: readonly WorkspaceRow[];
}

export async function workspacesPage(backend: Backend): Promise<WorkspacesPage> {
  const changes = new Set(await backend.listChanges());
  const rows: WorkspaceRow[] = [];
  for (const workspace of await backend.workspaces()) {
    const change = workspace.change !== undefined && changes.has(workspace.change) ? workspace.change : undefined;
    const entries = change === undefined ? [] : await backend.readLog(change);
    rows.push({
      workspace,
      display: displayPath(backend.root, workspace.path),
      isChange: change !== undefined,
      landed: landedMerge(entries) !== undefined,
      archived: currentArchived(entries),
    });
  }
  return { rows };
}

export function workspacesDoc(page: WorkspacesPage): Doc {
  const rows = page.rows.map(({ workspace, display, isChange, landed, archived }): readonly Cell[] => {
    const notes = [
      ...(workspace.dirty ? ["dirty"] : []),
      ...(landed ? ["landed"] : []),
      ...(archived ? ["archived"] : []),
    ];
    // A branch that is no change still opens a page, dimmed to say no log
    // stands behind it.
    const name =
      workspace.change === undefined
        ? span("(detached)", { style: "context" })
        : span(workspace.change, {
            style: isChange ? undefined : "context",
            target: { kind: "change", change: workspace.change },
          });
    return [span(display, { target: { kind: "workspace", path: workspace.path } }), name, span(notes.join(", "))];
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

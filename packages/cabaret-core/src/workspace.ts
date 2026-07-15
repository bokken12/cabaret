import { assertChangeExists, assertNotLanded, type Backend, type RefName, type Workspace } from "./backend.js";
import type { Config } from "./config.js";
import { UserError } from "./error.js";

/**
 * The workspace is dirty where the operation wants a clean one. The message
 * states only the fact; each frontend attaches its own override remedy — a
 * flag, a confirmation dialog — before showing it.
 */
export class DirtyWorkspaceError extends UserError {
  constructor(readonly path: string) {
    super(`workspace has uncommitted changes: ${path}`);
  }
}

/**
 * The workspace holding `change` — the one with its branch checked out — or
 * undefined. A branch is checked out in at most one workspace, so this is
 * the change's only home.
 */
export async function changeWorkspace(backend: Backend, change: RefName): Promise<Workspace | undefined> {
  return (await backend.workspaces()).find((workspace) => workspace.branch === change);
}

/** The primary working tree; every repository has one. */
function primaryWorkspace(workspaces: readonly Workspace[]): Workspace {
  const primary = workspaces[0];
  if (primary === undefined || !primary.primary) {
    throw new Error("repository has no primary workspace");
  }
  return primary;
}

/**
 * Where a new workspace for `change` goes: under `home` when configured, and
 * otherwise beside the primary workspace, named after it — `widgets-gadget`
 * beside `widgets`. A change name with `/` in it nests directories either
 * way, as it does under `refs/heads/`.
 */
export function workspacePath(home: string | undefined, primary: string, change: RefName): string {
  return home === undefined ? `${primary}-${change}` : `${home}/${change}`;
}

/** Fail unless `change` is a change whose branch exists — what a workspace can check out. */
async function assertCheckoutable(backend: Backend, change: RefName): Promise<void> {
  const entries = await backend.readLog(change);
  assertChangeExists(change, entries);
  assertNotLanded(change, entries);
  if ((await backend.branchTip(change)) === undefined) {
    throw new UserError(`branch does not exist: ${JSON.stringify(change)}`);
  }
}

/**
 * Create a workspace with `change` checked out, at `path` or the
 * `workspacePath` default, and return where it went. The change must be a
 * real, unlanded change without a workspace already.
 */
export async function addChangeWorkspace(
  backend: Backend,
  config: Config,
  change: RefName,
  path?: string,
): Promise<string> {
  await assertCheckoutable(backend, change);
  const workspaces = await backend.workspaces();
  const holding = workspaces.find((workspace) => workspace.branch === change);
  if (holding !== undefined) {
    throw new UserError(`change already has a workspace: ${holding.path}`);
  }
  const target = path ?? workspacePath(config.workspaceHome, primaryWorkspace(workspaces).path, change);
  await backend.addWorkspace(target, change);
  return target;
}

/**
 * Remove the workspace holding `change` and return its path. A dirty
 * workspace is refused unless `evenThoughDirty`, which discards its
 * uncommitted changes; the branch itself is untouched either way.
 */
export async function removeChangeWorkspace(
  backend: Backend,
  change: RefName,
  evenThoughDirty: boolean,
): Promise<string> {
  const workspace = await changeWorkspace(backend, change);
  if (workspace === undefined) {
    throw new UserError(`change has no workspace: ${JSON.stringify(change)}`);
  }
  if (workspace.primary) {
    throw new UserError(`cannot remove the primary workspace: ${workspace.path}`);
  }
  if (workspace.dirty && !evenThoughDirty) {
    throw new DirtyWorkspaceError(workspace.path);
  }
  await backend.removeWorkspace(workspace.path, evenThoughDirty);
  return workspace.path;
}

/** How `gotoChange` put the change in front of the user. */
export type GotoResult =
  /** The change already had a workspace. */
  | { readonly kind: "at"; readonly path: string }
  /** The change is now checked out in the workspace the backend was opened in. */
  | { readonly kind: "checked-out"; readonly path: string }
  /** A dedicated workspace was created for the change. */
  | { readonly kind: "added"; readonly path: string };

/**
 * Bring `change` into a workspace and say where: its own workspace when it
 * has one, and otherwise per `config.workspaceStyle` — checked out in the
 * current workspace ("shared", refusing a dirty one unless
 * `evenThoughDirty`), or in a fresh dedicated workspace ("dedicated").
 */
export async function gotoChange(
  backend: Backend,
  config: Config,
  change: RefName,
  evenThoughDirty: boolean,
): Promise<GotoResult> {
  const workspaces = await backend.workspaces();
  const holding = workspaces.find((workspace) => workspace.branch === change);
  if (holding !== undefined) {
    return { kind: "at", path: holding.path };
  }
  await assertCheckoutable(backend, change);
  if (config.workspaceStyle === "dedicated") {
    const path = workspacePath(config.workspaceHome, primaryWorkspace(workspaces).path, change);
    await backend.addWorkspace(path, change);
    return { kind: "added", path };
  }
  const current = workspaces.find((workspace) => workspace.path === backend.root);
  if (current === undefined) {
    throw new Error(`current working tree is not a workspace: ${backend.root}`);
  }
  if (current.dirty && !evenThoughDirty) {
    throw new DirtyWorkspaceError(current.path);
  }
  await backend.checkout(change);
  return { kind: "checked-out", path: current.path };
}

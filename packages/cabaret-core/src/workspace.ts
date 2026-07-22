import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  currentArchived,
  ensureBranch,
  type Workspace,
} from "./backend.js";
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
 * The workspace holding `change` — the one with it checked out — or
 * undefined. A change is checked out in at most one workspace, so this is
 * its only home.
 */
export async function changeWorkspace(backend: Backend, change: ChangeName): Promise<Workspace | undefined> {
  return (await backend.workspaces()).find((workspace) => workspace.change === change);
}

/** The primary working tree; every repository has one. */
function primaryWorkspace(workspaces: readonly Workspace[]): Workspace {
  const primary = workspaces[0];
  if (primary === undefined || !primary.primary) {
    throw new Error("repository has no primary workspace");
  }
  return primary;
}

/** The workspace the backend was opened in. */
function currentWorkspace(backend: Backend, workspaces: readonly Workspace[]): Workspace {
  const current = workspaces.find((workspace) => workspace.path === backend.root);
  if (current === undefined) {
    throw new Error(`current working tree is not a workspace: ${backend.root}`);
  }
  return current;
}

/**
 * Where a new workspace for `change` goes: beside the primary workspace,
 * named after it — `widgets-gadget` beside `widgets`. A change name with
 * `/` in it nests directories.
 */
export function workspacePath(primary: string, change: ChangeName): string {
  return `${primary}-${change}`;
}

/**
 * Fail unless `change` is a change whose code exists — what a workspace can
 * check out — creating its branch from origin's copy when only origin holds
 * one: checking out is the moment such a change materializes.
 */
async function assertCheckoutable(backend: Backend, change: ChangeName): Promise<void> {
  const entries = await backend.readLog(change);
  assertChangeExists(change, entries);
  await ensureBranch(backend, change);
}

/**
 * Create a workspace with `change` checked out, at `path` or the
 * `workspacePath` default, and return where it went. The change must be a
 * real change without a workspace already.
 */
export async function addChangeWorkspace(backend: Backend, change: ChangeName, path?: string): Promise<string> {
  await assertCheckoutable(backend, change);
  const workspaces = await backend.workspaces();
  const holding = workspaces.find((workspace) => workspace.change === change);
  if (holding !== undefined) {
    throw new UserError(`change already has a workspace: ${holding.path}`);
  }
  const target = path ?? workspacePath(primaryWorkspace(workspaces).path, change);
  await backend.addWorkspace(target, change);
  return target;
}

/**
 * Remove the workspace holding `change` and return its path. A dirty
 * workspace is refused unless `evenThoughDirty`, which discards its
 * uncommitted changes; the change itself is untouched either way.
 */
export async function removeChangeWorkspace(
  backend: Backend,
  change: ChangeName,
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

/** A workspace reclaiming considered, and what it did with it. */
export interface ReclaimedWorkspace {
  readonly path: string;
  readonly change: ChangeName;
  /** Removed, or kept: dirty guards uncommitted work; primary and current can never go. */
  readonly outcome: "removed" | "dirty" | "primary" | "current";
}

/**
 * Remove every workspace whose change is archived — set aside, or done
 * because landing archived it; the ones pages nudge about — and return what
 * happened to each. With `all`, every
 * workspace holding its branch cleanly goes: removing one costs nothing the
 * branch does not keep, which frees space when it is needed. Either way a
 * dirty workspace keeps its uncommitted work, and the primary and current
 * workspaces stay put; reporting them keeps what the reclaim leaves
 * standing from reading as a miss. A detached workspace is never touched —
 * its position lives nowhere else.
 */
export async function reclaimWorkspaces(backend: Backend, all: boolean): Promise<readonly ReclaimedWorkspace[]> {
  const reclaimed: ReclaimedWorkspace[] = [];
  for (const { path, change, dirty, primary } of await backend.workspaces()) {
    if (change === undefined) {
      continue;
    }
    const entries = await backend.readLog(change);
    if (!all && !currentArchived(entries)) {
      continue;
    }
    const outcome = primary ? "primary" : path === backend.root ? "current" : dirty ? "dirty" : "removed";
    if (outcome === "removed") {
      await backend.removeWorkspace(path, false);
    }
    reclaimed.push({ path, change, outcome });
  }
  return reclaimed;
}

/**
 * Check `change` out in the current workspace and return that workspace's
 * path, refusing a dirty workspace unless `evenThoughDirty`. A change held
 * by another workspace cannot be checked out — the backend refuses it.
 */
export async function checkoutChange(backend: Backend, change: ChangeName, evenThoughDirty: boolean): Promise<string> {
  await assertCheckoutable(backend, change);
  const current = currentWorkspace(backend, await backend.workspaces());
  if (current.dirty && !evenThoughDirty) {
    throw new DirtyWorkspaceError(current.path);
  }
  await backend.checkout(change);
  return current.path;
}

/** A way to bring `change` in front of the user, offered when the current workspace does not hold it. */
export type GotoOption =
  /** Open the workspace that holds the change. */
  | { readonly kind: "open"; readonly path: string }
  /** Check the change out in the current workspace. */
  | { readonly kind: "checkout" }
  /** Create the change's dedicated workspace. */
  | { readonly kind: "add"; readonly path: string };

/** Where visiting `change` finds it: checked out here, or reachable through one of the offered options. */
export type GotoOffer =
  | { readonly kind: "here" }
  | { readonly kind: "offer"; readonly options: readonly [GotoOption, ...GotoOption[]] };

/**
 * How to visit `change` from the current workspace: "here" when this
 * workspace holds it, and otherwise the options worth offering — the
 * workspace it already has, a checkout here when this tree is clean, and a
 * dedicated workspace when the style prefers one or a dirty tree rules the
 * checkout out. The style-preferred option comes first.
 */
export async function gotoOffer(backend: Backend, config: Config, change: ChangeName): Promise<GotoOffer> {
  const workspaces = await backend.workspaces();
  const holding = workspaces.find((workspace) => workspace.change === change);
  if (holding !== undefined) {
    return holding.path === backend.root
      ? { kind: "here" }
      : { kind: "offer", options: [{ kind: "open", path: holding.path }] };
  }
  const add: GotoOption = { kind: "add", path: workspacePath(primaryWorkspace(workspaces).path, change) };
  if (currentWorkspace(backend, workspaces).dirty) {
    return { kind: "offer", options: [add] };
  }
  const checkout: GotoOption = { kind: "checkout" };
  return {
    kind: "offer",
    options: config.workspaceStyle === "dedicated" ? [add, checkout] : [checkout],
  };
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
  change: ChangeName,
  evenThoughDirty: boolean,
): Promise<GotoResult> {
  const workspaces = await backend.workspaces();
  const holding = workspaces.find((workspace) => workspace.change === change);
  if (holding !== undefined) {
    return { kind: "at", path: holding.path };
  }
  if (config.workspaceStyle === "dedicated") {
    await assertCheckoutable(backend, change);
    const path = workspacePath(primaryWorkspace(workspaces).path, change);
    await backend.addWorkspace(path, change);
    return { kind: "added", path };
  }
  return { kind: "checked-out", path: await checkoutChange(backend, change, evenThoughDirty) };
}

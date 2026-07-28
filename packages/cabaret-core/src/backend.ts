import type { ConfigField } from "./config.ts";
import type { Forge } from "./forge.ts";
import type { Git } from "./git.ts";
import type { LogAction } from "./log.ts";
import type { Change, ChangeID, FileGlob, FilePath, Revision, Username } from "./types.ts";

// TODO(jm): decide on superclass vs interface
export class Backend {
  protected git: Git;
  // TODO-someday(jm): add in forge and wrapping

  // === internal ===

  private async logAction(change: ChangeID, action: LogAction) {}

  // === cross-change actions ===

  public async fetch() {}

  public async land(change: ChangeID) {}

  // === observation ===

  public async conflicts(change: ChangeID) {}

  public async diff(change: ChangeID) {}

  public async read(change: ChangeID): Promise<Change> {}

  public async review(change: ChangeID) {}

  public async todos(change: ChangeID) {}

  // === log actions ===

  // TODO(jm): all should avoid writing if already up to date, and return updated change.

  public async forget(change: ChangeID, file: FilePath) {}

  public async mark(change: ChangeID, file: FilePath, rev: Revision) {}

  public async rebase(change: ChangeID) {}

  public async reparent(change: ChangeID) {}

  public async setArchived(change: ChangeID, archived: boolean) {}

  public async setOwner(change: ChangeID, owner: Username) {}

  // === config management ===

  public async getConfig<T>(field: ConfigField<T>): Promise<T> {}

  public async setConfig<T>(field: ConfigField<T>, value: T) {}

  // === workspace management ===

  public async commit(change: ChangeID, files: ReadonlyArray<FileGlob>);

  public async workspaceAdd(change: ChangeID) {}

  public async workspaceRemove(change: ChangeID) {}

  public async workspaceDir(change: ChangeID) {}
}

// TODO-someday(jm): add caching layers.

/** Caches expensive queries (e.g. computing review obligations) under `.git/` so they can be reused when their sources are unchanged. This allows caching even between distinct CLI commands. */
export class DiskCacheBackend extends Backend {}

/** Caches queries that require subprocess spawns (e.g. ancestry checks) in-memory. This only works on long-running Cabaret processes like the TUI or VSCode extension. */
export class MemCacheBackend {}

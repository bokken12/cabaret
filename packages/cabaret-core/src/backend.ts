import type { ConfigField } from "./config.ts";
import type { Git } from "./git.ts";
import type { LogAction } from "./log.ts";
import type { Change, ChangeID, FileGlob, FilePath, Revision, Username, ChangeMeta, Base } from "./types.ts";

// TODO(jm): decide on superclass vs interface
export class Backend {
  protected git: Git;
  // TODO-someday(jm): add in forge and wrapping

  public constructor(git: Git) {
    this.git = git;
  }

  // === internal ===

  protected async readMeta(change: ChangeID): Promise<ChangeMeta> {
    throw new Error("unimplemented");
  }

  protected async computeBase(change: ChangeMeta): Promise<Base> {
    if (change.parents.length === 0) {
      // Feature with no parents has no diff, use the tip as the base
      throw new Error("unimplemented");
    } else if (change.parents.length === 1) {
      // TODO-someday(jm): allow retained tip under history editing
      // base = gca(tip, parent.tip)
      throw new Error("unimplemented");
    } else {
      // base = synthetic merge of all gca(tip, parent.tip) unless a single one is a
      // descendant of all the others, in which case it can be the base.
      throw new Error("unimplemented");
    }
  }

  protected async logAction(_change: ChangeID, _action: LogAction): Promise<void> {
    throw new Error("unimplemented");
  }

  // === cross-change actions ===

  public async fetch(): Promise<void> {
    // TODO(jm): fetch logs, fast-forward, push
    await this.git.fetch();
  }

  /** Initial state: A - B - C (B must have a single parent)
   *
   * Merges this change (B) into its parent (A).
   *
   * For each child C: remove B from its parents, then add A to its parents unless A is already an ancestor of one of
   * its other parents.
   */
  public async land(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  // === observation ===

  // TODO(jm): pin down return types; void is a placeholder.

  public async conflicts(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async diff(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async read(_change: ChangeID): Promise<Change> {
    throw new Error("unimplemented");
  }

  public async review(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async todos(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  // === log actions ===

  // TODO(jm): all should avoid writing if already up to date, and return updated change.

  public async mark(_change: ChangeID, _file: FilePath, _rev: Revision): Promise<void> {
    throw new Error("unimplemented");
  }

  public async rebase(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async reparent(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async setArchived(_change: ChangeID, _archived: boolean): Promise<void> {
    throw new Error("unimplemented");
  }

  public async setOwner(_change: ChangeID, _owner: Username): Promise<void> {
    throw new Error("unimplemented");
  }

  // === config management ===

  public async getConfig<T>(_field: ConfigField<T>): Promise<T> {
    throw new Error("unimplemented");
  }

  public async setConfig<T>(_field: ConfigField<T>, _value: T): Promise<void> {
    throw new Error("unimplemented");
  }

  // === workspace management ===

  public async commit(_change: ChangeID, _files: ReadonlyArray<FileGlob>): Promise<void> {
    throw new Error("unimplemented");
  }

  public async workspaceAdd(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async workspaceRemove(_change: ChangeID): Promise<void> {
    throw new Error("unimplemented");
  }

  public async workspaceDir(_change: ChangeID): Promise<string> {
    throw new Error("unimplemented");
  }
}

// TODO-someday(jm): add caching layers.

/** Caches expensive queries (e.g. computing review obligations) under `.git/` so they can be reused when their sources are unchanged. This allows caching even between distinct CLI commands. */
export class DiskCacheBackend extends Backend {}

/** Caches queries that require subprocess spawns (e.g. ancestry checks) in-memory. This only works on long-running Cabaret processes like the TUI or VSCode extension. */
export class MemCacheBackend {}

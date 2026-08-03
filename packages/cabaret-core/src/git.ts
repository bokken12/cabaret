import { GitError, type SimpleGit, simpleGit } from "simple-git";
import type { FilePath, Ref } from "./types.ts";

/** Typed interface to `git` onto which Cabaret can translate its operations. */
export interface Git {
  fetch(): Promise<void>;
  /** Contents of the file at `ref:path`, or undefined if the ref or path does not exist. */
  readBlob(ref: Ref, path: FilePath): Promise<string | undefined>;
}

// TODO: Add an in-process, memfs-backed IsomorphicGit implementation for tests.
// export class IsomorphicGit implements Git {}

/** Shells out to the local `git` binary. Built on the `simple-git` library. */
export class ShellGit implements Git {
  private readonly client: SimpleGit;

  public constructor(client: SimpleGit = simpleGit()) {
    this.client = client;
  }

  public async fetch(): Promise<void> {
    await this.client.fetch();
  }

  public async readBlob(ref: Ref, path: FilePath): Promise<string | undefined> {
    try {
      return await this.client.show([`${ref}:${path}`]);
    } catch (e) {
      if (e instanceof GitError && /invalid object name|does not exist/i.test(e.message)) return undefined;
      throw e;
    }
  }
}

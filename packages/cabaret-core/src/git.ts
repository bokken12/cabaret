import { type SimpleGit, simpleGit } from "simple-git";

/** Typed interface to `git` onto which Cabaret can translate its operations. */
export interface Git {
  fetch(): Promise<void>;
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
}
